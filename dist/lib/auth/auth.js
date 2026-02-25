/**
 * @fileoverview OAuth authentication utilities for Qwen Plugin
 * Implements OAuth 2.0 Device Authorization Grant flow (RFC 8628)
 * Handles token storage, refresh, and validation
 * @license MIT
 */

import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, statSync } from "fs";
import { dirname } from "path";
import { QWEN_OAUTH, DEFAULT_QWEN_BASE_URL, TOKEN_REFRESH_BUFFER_MS, VERIFICATION_URI } from "../constants.js";
import { getTokenPath, getQwenDir, getTokenLockPath, getLegacyTokenPath, getAccountsPath, getAccountsLockPath } from "../config.js";
import { logError, logWarn, logInfo, LOGGING_ENABLED } from "../logger.js";

/** Maximum number of retries for token refresh operations */
const MAX_REFRESH_RETRIES = 2;
/** Delay between retry attempts in milliseconds */
const REFRESH_RETRY_DELAY_MS = 2000;
/** Timeout for OAuth HTTP requests in milliseconds */
const OAUTH_REQUEST_TIMEOUT_MS = 15000;
/** Lock timeout for multi-process token refresh coordination */
const LOCK_TIMEOUT_MS = 10000;
/** Interval between lock acquisition attempts */
const LOCK_ATTEMPT_INTERVAL_MS = 100;
/** Backoff multiplier for lock retry interval */
const LOCK_BACKOFF_MULTIPLIER = 1.5;
/** Maximum interval between lock attempts */
const LOCK_MAX_INTERVAL_MS = 2000;
/** Maximum number of lock acquisition attempts */
const LOCK_MAX_ATTEMPTS = 20;
/** Account schema version for ~/.qwen/oauth_accounts.json */
const ACCOUNT_STORE_VERSION = 1;
/** Default cooldown when account hits insufficient_quota */
const DEFAULT_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Checks if an error is an AbortError (from AbortController)
 * @param {*} error - The error to check
 * @returns {boolean} True if error is an AbortError
 */
function isAbortError(error) {
    return typeof error === "object" && error !== null && ("name" in error) && error.name === "AbortError";
}

/**
 * Checks if an error has a specific error code (for Node.js system errors)
 * @param {*} error - The error to check
 * @param {string} code - The error code to look for (e.g., "EEXIST", "ENOENT")
 * @returns {boolean} True if error has the specified code
 */
function hasErrorCode(error, code) {
    return typeof error === "object" && error !== null && ("code" in error) && error.code === code;
}

/**
 * Creates a promise that resolves after specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after delay
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Performs fetch with timeout using AbortController
 * Automatically aborts request if it exceeds timeout
 * @param {string} url - URL to fetch
 * @param {RequestInit} [init] - Fetch options
 * @param {number} [timeoutMs=OAUTH_REQUEST_TIMEOUT_MS] - Timeout in milliseconds
 * @returns {Promise<Response>} Fetch response
 * @throws {Error} If request times out
 */
async function fetchWithTimeout(url, init, timeoutMs = OAUTH_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    }
    catch (error) {
        if (isAbortError(error)) {
            throw new Error(`OAuth request timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Normalizes resource URL to valid HTTPS URL format
 * Adds https:// prefix if missing and validates URL format
 * @param {string|undefined} resourceUrl - URL to normalize
 * @returns {string|undefined} Normalized URL or undefined if invalid
 */
function normalizeResourceUrl(resourceUrl) {
    if (!resourceUrl)
        return undefined;
    try {
        let normalizedUrl = resourceUrl;
        // Add https:// prefix if protocol is missing
        if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
            normalizedUrl = `https://${normalizedUrl}`;
        }
        // Validate URL format
        new URL(normalizedUrl);
        if (LOGGING_ENABLED) {
            logInfo("Valid resource_url found and normalized:", normalizedUrl);
        }
        return normalizedUrl;
    }
    catch (error) {
        logWarn("invalid resource_url:", { original: resourceUrl, error });
        return undefined;
    }
}

/**
 * Validates OAuth token response has required fields
 * @param {Object} json - Token response JSON
 * @param {string} context - Context for error messages (e.g., "token response", "refresh response")
 * @returns {boolean} True if response is valid
 */
function validateTokenResponse(json, context) {
    // Check access_token exists and is string
    if (!json.access_token || typeof json.access_token !== "string") {
        logError(`${context} missing access_token`);
        return false;
    }
    // Check refresh_token exists and is string
    if (!json.refresh_token || typeof json.refresh_token !== "string") {
        logError(`${context} missing refresh_token`);
        return false;
    }
    // Check expires_in is valid positive number
    if (typeof json.expires_in !== "number" || json.expires_in <= 0) {
        logError(`${context} invalid expires_in:`, json.expires_in);
        return false;
    }
    return true;
}
/**
 * Converts raw token data to standardized stored token format
 * Handles different field name variations (expiry_date vs expires)
 * @param {Object} data - Raw token data from OAuth response or file
 * @returns {Object|null} Normalized token data or null if invalid
 */
function toStoredTokenData(data) {
    if (!data || typeof data !== "object") {
        return null;
    }
    const raw = data;
    const accessToken = typeof raw.access_token === "string" ? raw.access_token : undefined;
    const refreshToken = typeof raw.refresh_token === "string" ? raw.refresh_token : undefined;
    const tokenType = typeof raw.token_type === "string" && raw.token_type.length > 0 ? raw.token_type : "Bearer";
    // Handle both expiry_date and expires field names
    const expiryDate = typeof raw.expiry_date === "number"
        ? raw.expiry_date
        : typeof raw.expires === "number"
            ? raw.expires
            : typeof raw.expiry_date === "string"
                ? Number(raw.expiry_date)
                : undefined;
    const resourceUrl = typeof raw.resource_url === "string" ? normalizeResourceUrl(raw.resource_url) : undefined;
    // Validate all required fields are present and valid
    if (!accessToken || !refreshToken || typeof expiryDate !== "number" || !Number.isFinite(expiryDate) || expiryDate <= 0) {
        return null;
    }
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: tokenType,
        expiry_date: expiryDate,
        resource_url: resourceUrl,
    };
}

function getQuotaCooldownMs() {
    const raw = process.env.OPENCODE_QWEN_QUOTA_COOLDOWN_MS;
    if (typeof raw !== "string" || raw.trim().length === 0) {
        return DEFAULT_QUOTA_COOLDOWN_MS;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1000) {
        return DEFAULT_QUOTA_COOLDOWN_MS;
    }
    return Math.floor(parsed);
}

function normalizeAccountStore(raw) {
    const fallback = {
        version: ACCOUNT_STORE_VERSION,
        activeAccountId: null,
        accounts: [],
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return fallback;
    }
    const input = raw;
    const accounts = Array.isArray(input.accounts) ? input.accounts : [];
    const normalizedAccounts = [];
    for (const item of accounts) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            continue;
        }
        const token = toStoredTokenData(item.token);
        if (!token) {
            continue;
        }
        const id = typeof item.id === "string" && item.id.trim().length > 0
            ? item.id.trim()
            : `acct_${Math.random().toString(16).slice(2)}_${Date.now().toString(36)}`;
        const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
        const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt;
        const exhaustedUntil = typeof item.exhaustedUntil === "number" && Number.isFinite(item.exhaustedUntil) ? item.exhaustedUntil : 0;
        const lastErrorCode = typeof item.lastErrorCode === "string" ? item.lastErrorCode : undefined;
        const accountKey = typeof item.accountKey === "string" && item.accountKey.trim().length > 0 ? item.accountKey.trim() : undefined;
        normalizedAccounts.push({
            id,
            token,
            resource_url: token.resource_url,
            exhaustedUntil,
            lastErrorCode,
            accountKey,
            createdAt,
            updatedAt,
        });
    }
    let activeAccountId = typeof input.activeAccountId === "string" && input.activeAccountId.length > 0 ? input.activeAccountId : null;
    if (activeAccountId && !normalizedAccounts.some(account => account.id === activeAccountId)) {
        activeAccountId = null;
    }
    if (!activeAccountId && normalizedAccounts.length > 0) {
        activeAccountId = normalizedAccounts[0].id;
    }
    return {
        version: ACCOUNT_STORE_VERSION,
        activeAccountId,
        accounts: normalizedAccounts,
    };
}

function normalizeTokenResultToStored(tokenResult) {
    if (!tokenResult || tokenResult.type !== "success") {
        return null;
    }
    return toStoredTokenData({
        access_token: tokenResult.access,
        refresh_token: tokenResult.refresh,
        token_type: "Bearer",
        expiry_date: tokenResult.expires,
        resource_url: tokenResult.resourceUrl,
    });
}

function parseJwtPayloadSegment(token) {
    if (typeof token !== "string") {
        return null;
    }
    const parts = token.split(".");
    if (parts.length < 2) {
        return null;
    }
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    try {
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    }
    catch (_error) {
        return null;
    }
}

function deriveAccountKeyFromToken(tokenData) {
    if (!tokenData || typeof tokenData !== "object") {
        return null;
    }
    const payload = parseJwtPayloadSegment(tokenData.access_token);
    if (payload && typeof payload === "object") {
        const candidates = ["sub", "uid", "user_id", "email", "username"];
        for (const key of candidates) {
            const value = payload[key];
            if (typeof value === "string" && value.trim().length > 0) {
                return `${key}:${value.trim()}`;
            }
        }
    }
    if (typeof tokenData.refresh_token === "string" && tokenData.refresh_token.length > 12) {
        return `refresh:${tokenData.refresh_token}`;
    }
    return null;
}

function buildAccountEntry(tokenData, accountId, accountKey) {
    const now = Date.now();
    return {
        id: accountId,
        token: tokenData,
        resource_url: tokenData.resource_url,
        exhaustedUntil: 0,
        lastErrorCode: undefined,
        accountKey: accountKey || undefined,
        createdAt: now,
        updatedAt: now,
    };
}

function writeAccountsStoreData(store) {
    const accountsPath = getAccountsPath();
    const accountsDir = dirname(accountsPath);
    const qwenDir = getQwenDir();
    if (!existsSync(qwenDir)) {
        mkdirSync(qwenDir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(accountsDir)) {
        mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
    }
    const tempPath = `${accountsPath}.tmp.${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    const payload = {
        version: ACCOUNT_STORE_VERSION,
        activeAccountId: store.activeAccountId || null,
        accounts: store.accounts.map(account => ({
            id: account.id,
            token: account.token,
            resource_url: account.resource_url,
            exhaustedUntil: account.exhaustedUntil || 0,
            lastErrorCode: account.lastErrorCode,
            accountKey: account.accountKey,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
        })),
    };
    try {
        writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
        renameSync(tempPath, accountsPath);
    }
    catch (error) {
        try {
            if (existsSync(tempPath)) {
                unlinkSync(tempPath);
            }
        }
        catch (_cleanupError) {
        }
        throw error;
    }
}

function loadAccountsStoreData() {
    const path = getAccountsPath();
    if (!existsSync(path)) {
        return normalizeAccountStore(null);
    }
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        return normalizeAccountStore(raw);
    }
    catch (error) {
        logWarn("Failed to read oauth_accounts.json, using empty store", error);
        return normalizeAccountStore(null);
    }
}

function pickNextHealthyAccount(store, excludedIds = new Set(), now = Date.now()) {
    const accounts = Array.isArray(store.accounts) ? store.accounts : [];
    if (accounts.length === 0) {
        return null;
    }
    const activeIndex = accounts.findIndex(account => account.id === store.activeAccountId);
    for (let step = 1; step <= accounts.length; step += 1) {
        const index = activeIndex >= 0 ? (activeIndex + step) % accounts.length : (step - 1);
        const candidate = accounts[index];
        if (!candidate || excludedIds.has(candidate.id)) {
            continue;
        }
        if (typeof candidate.exhaustedUntil === "number" && candidate.exhaustedUntil > now) {
            continue;
        }
        return candidate;
    }
    return null;
}

function countHealthyAccounts(store, now = Date.now()) {
    return store.accounts.filter(account => !(typeof account.exhaustedUntil === "number" && account.exhaustedUntil > now)).length;
}

function syncAccountToLegacyTokenFile(account) {
    writeStoredTokenData({
        access_token: account.token.access_token,
        refresh_token: account.token.refresh_token,
        token_type: account.token.token_type || "Bearer",
        expiry_date: account.token.expiry_date,
        resource_url: account.resource_url,
    });
}

/**
 * Builds token success object from stored token data
 * @param {Object} stored - Stored token data from file
 * @returns {Object} Token success object for SDK
 */
function buildTokenSuccessFromStored(stored) {
    return {
        type: "success",
        access: stored.access_token,
        refresh: stored.refresh_token,
        expires: stored.expiry_date,
        resourceUrl: stored.resource_url,
    };
}
/**
 * Writes token data to disk atomically using temp file + rename
 * Uses secure file permissions (0o600 - owner read/write only)
 * @param {Object} tokenData - Token data to write
 * @throws {Error} If write operation fails
 */
function writeStoredTokenData(tokenData) {
    const qwenDir = getQwenDir();
    // Create directory if it doesn't exist with secure permissions
    if (!existsSync(qwenDir)) {
        mkdirSync(qwenDir, { recursive: true, mode: 0o700 });
    }
    const tokenPath = getTokenPath();
    // Use atomic write: write to temp file then rename
    const tempPath = `${tokenPath}.tmp.${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    try {
        writeFileSync(tempPath, JSON.stringify(tokenData, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
        renameSync(tempPath, tokenPath);
    }
    catch (error) {
        // Clean up temp file on error
        try {
            if (existsSync(tempPath)) {
                unlinkSync(tempPath);
            }
        }
        catch (_cleanupError) {
        }
        throw error;
    }
}

/**
 * Migrates legacy token from old plugin location to new location
 * Checks if new token file exists, if not tries to migrate from legacy path
 */
function migrateLegacyTokenIfNeeded() {
    const tokenPath = getTokenPath();
    // Skip if new token file already exists
    if (existsSync(tokenPath)) {
        return;
    }
    const legacyPath = getLegacyTokenPath();
    // Skip if legacy file doesn't exist
    if (!existsSync(legacyPath)) {
        return;
    }
    try {
        const legacyRaw = readFileSync(legacyPath, "utf-8");
        const legacyData = JSON.parse(legacyRaw);
        const converted = toStoredTokenData(legacyData);
        if (!converted) {
            logWarn("Legacy token found but invalid, skipping migration");
            return;
        }
        writeStoredTokenData(converted);
        logInfo("Migrated token from legacy path to ~/.qwen/oauth_creds.json");
    }
    catch (error) {
        logWarn("Failed to migrate legacy token:", error);
    }
}

function migrateLegacyTokenToAccountsIfNeeded() {
    const accountsPath = getAccountsPath();
    if (existsSync(accountsPath)) {
        return;
    }
    const legacyToken = loadStoredToken();
    if (!legacyToken) {
        return;
    }
    const tokenData = toStoredTokenData(legacyToken);
    if (!tokenData) {
        return;
    }
    const accountKey = deriveAccountKeyFromToken(tokenData);
    const accountId = `acct_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
    const store = normalizeAccountStore({
        version: ACCOUNT_STORE_VERSION,
        activeAccountId: accountId,
        accounts: [buildAccountEntry(tokenData, accountId, accountKey)],
    });
    try {
        writeAccountsStoreData(store);
        if (LOGGING_ENABLED) {
            logInfo("Migrated legacy oauth_creds.json to oauth_accounts.json");
        }
    }
    catch (error) {
        logWarn("Failed to migrate legacy token to oauth_accounts.json", error);
    }
}
/**
 * Acquires exclusive lock for token refresh to prevent concurrent refreshes
 * Uses file-based locking with exponential backoff retry strategy
 * @returns {Promise<string>} Lock file path if acquired successfully
 * @throws {Error} If lock cannot be acquired within timeout
 */
async function acquireTokenLock() {
    const lockPath = getTokenLockPath();
    const qwenDir = getQwenDir();
    if (!existsSync(qwenDir)) {
        mkdirSync(qwenDir, { recursive: true, mode: 0o700 });
    }
    const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let waitMs = LOCK_ATTEMPT_INTERVAL_MS;
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        try {
            // Try to create lock file with exclusive flag
            writeFileSync(lockPath, lockValue, {
                encoding: "utf-8",
                flag: "wx",
                mode: 0o600,
            });
            return lockPath;
        }
        catch (error) {
            // EEXIST means lock file already exists
            if (!hasErrorCode(error, "EEXIST")) {
                throw error;
            }
            try {
                const stats = statSync(lockPath);
                const ageMs = Date.now() - stats.mtimeMs;
                // Remove stale lock if it's older than timeout
                if (ageMs > LOCK_TIMEOUT_MS) {
                    try {
                        unlinkSync(lockPath);
                        logWarn("Removed stale token lock file", { lockPath, ageMs });
                    }
                    catch (staleError) {
                        if (!hasErrorCode(staleError, "ENOENT")) {
                            logWarn("Failed to remove stale token lock", staleError);
                        }
                    }
                    continue;
                }
            }
            catch (statError) {
                if (!hasErrorCode(statError, "ENOENT")) {
                    logWarn("Failed to inspect token lock file", statError);
                }
            }
            // Wait with exponential backoff before retry
            await sleep(waitMs);
            waitMs = Math.min(Math.floor(waitMs * LOCK_BACKOFF_MULTIPLIER), LOCK_MAX_INTERVAL_MS);
        }
    }
    throw new Error("Token refresh lock timeout");
}

/**
 * Releases token refresh lock
 * Silently ignores errors if lock file doesn't exist
 * @param {string} lockPath - Path to lock file to release
 */
function releaseTokenLock(lockPath) {
    try {
        unlinkSync(lockPath);
    }
    catch (error) {
        // Ignore ENOENT (file not found) errors
        if (!hasErrorCode(error, "ENOENT")) {
            logWarn("Failed to release token lock file", error);
        }
    }
}

async function acquireAccountsLock() {
    const lockPath = getAccountsLockPath();
    const lockDir = dirname(lockPath);
    if (!existsSync(lockDir)) {
        mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    }
    const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let waitMs = LOCK_ATTEMPT_INTERVAL_MS;
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        try {
            writeFileSync(lockPath, lockValue, {
                encoding: "utf-8",
                flag: "wx",
                mode: 0o600,
            });
            return lockPath;
        }
        catch (error) {
            if (!hasErrorCode(error, "EEXIST")) {
                throw error;
            }
            try {
                const stats = statSync(lockPath);
                const ageMs = Date.now() - stats.mtimeMs;
                if (ageMs > LOCK_TIMEOUT_MS) {
                    try {
                        unlinkSync(lockPath);
                    }
                    catch (staleError) {
                        if (!hasErrorCode(staleError, "ENOENT")) {
                            logWarn("Failed to remove stale accounts lock", staleError);
                        }
                    }
                    continue;
                }
            }
            catch (statError) {
                if (!hasErrorCode(statError, "ENOENT")) {
                    logWarn("Failed to inspect accounts lock file", statError);
                }
            }
            await sleep(waitMs);
            waitMs = Math.min(Math.floor(waitMs * LOCK_BACKOFF_MULTIPLIER), LOCK_MAX_INTERVAL_MS);
        }
    }
    throw new Error("Accounts lock timeout");
}

function releaseAccountsLock(lockPath) {
    try {
        unlinkSync(lockPath);
    }
    catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
            logWarn("Failed to release accounts lock file", error);
        }
    }
}

async function withAccountsStoreLock(mutator) {
    const lockPath = await acquireAccountsLock();
    try {
        const store = loadAccountsStoreData();
        const next = await mutator(store);
        if (next && typeof next === "object") {
            writeAccountsStoreData(next);
            return next;
        }
        writeAccountsStoreData(store);
        return store;
    }
    finally {
        releaseAccountsLock(lockPath);
    }
}
/**
 * Requests device code from Qwen OAuth server
 * Initiates OAuth 2.0 Device Authorization Grant flow
 * @param {{ challenge: string, verifier: string }} pkce - PKCE challenge and verifier
 * @returns {Promise<Object|null>} Device auth response or null on failure
 */
export async function requestDeviceCode(pkce) {
    try {
        const res = await fetchWithTimeout(QWEN_OAUTH.DEVICE_CODE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: new URLSearchParams({
                client_id: QWEN_OAUTH.CLIENT_ID,
                scope: QWEN_OAUTH.SCOPE,
                code_challenge: pkce.challenge,
                code_challenge_method: "S256",
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            logError("device code request failed:", { status: res.status, text });
            return null;
        }
        const json = await res.json();
        if (LOGGING_ENABLED) {
            logInfo("Device code response received:", json);
        }
        // Validate required fields are present
        if (!json.device_code || !json.user_code || !json.verification_uri) {
            logError("device code response missing fields:", json);
            return null;
        }
        // Fix verification_uri_complete if missing client parameter
        if (!json.verification_uri_complete || !json.verification_uri_complete.includes(VERIFICATION_URI.CLIENT_PARAM_KEY)) {
            const baseUrl = json.verification_uri_complete || json.verification_uri;
            const separator = baseUrl.includes("?") ? "&" : "?";
            json.verification_uri_complete = `${baseUrl}${separator}${VERIFICATION_URI.CLIENT_PARAM_VALUE}`;
            if (LOGGING_ENABLED) {
                logInfo("Fixed verification_uri_complete:", json.verification_uri_complete);
            }
        }
        return json;
    }
    catch (error) {
        logError("device code request error:", error);
        return null;
    }
}
/**
 * Polls Qwen OAuth server for access token using device code
 * Implements OAuth 2.0 Device Flow polling with proper error handling
 * @param {string} deviceCode - Device code from requestDeviceCode
 * @param {string} verifier - PKCE code verifier
 * @param {number} [interval=2] - Polling interval in seconds
 * @returns {Promise<Object>} Token result object with type: success|pending|slow_down|failed|denied|expired
 */
export async function pollForToken(deviceCode, verifier, interval = 2) {
    try {
        const res = await fetchWithTimeout(QWEN_OAUTH.TOKEN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: new URLSearchParams({
                grant_type: QWEN_OAUTH.GRANT_TYPE_DEVICE,
                client_id: QWEN_OAUTH.CLIENT_ID,
                device_code: deviceCode,
                code_verifier: verifier,
            }),
        });
        if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            const errorCode = typeof json.error === "string" ? json.error : undefined;
            const errorDescription = typeof json.error_description === "string" ? json.error_description : "No details provided";
            // Handle standard OAuth 2.0 Device Flow errors
            if (errorCode === "authorization_pending") {
                return { type: "pending" };
            }
            if (errorCode === "slow_down") {
                return { type: "slow_down" };
            }
            if (errorCode === "expired_token") {
                return { type: "expired" };
            }
            if (errorCode === "access_denied") {
                return { type: "denied" };
            }
            // Log and return fatal error for unknown errors
            logError("token poll failed:", {
                status: res.status,
                error: errorCode,
                description: errorDescription,
            });
            return {
                type: "failed",
                status: res.status,
                error: errorCode || "unknown_error",
                description: errorDescription,
                fatal: true,
            };
        }
        const json = await res.json();
        if (LOGGING_ENABLED) {
            logInfo("Token response received:", {
                has_access_token: !!json.access_token,
                has_refresh_token: !!json.refresh_token,
                expires_in: json.expires_in,
                resource_url: json.resource_url,
                all_fields: Object.keys(json),
            });
        }
        // Validate token response structure
        if (!validateTokenResponse(json, "token response")) {
            return {
                type: "failed",
                error: "invalid_token_response",
                description: "Token response missing required fields",
                fatal: true,
            };
        }
        json.resource_url = normalizeResourceUrl(json.resource_url);
        if (!json.resource_url) {
            logWarn("No valid resource_url in token response, will use default DashScope endpoint");
        }
        return {
            type: "success",
            access: json.access_token,
            refresh: json.refresh_token,
            expires: Date.now() + json.expires_in * 1000,
            resourceUrl: json.resource_url,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lowered = message.toLowerCase();
        // Identify transient errors that may succeed on retry
        const transient = lowered.includes("timed out") || lowered.includes("network") || lowered.includes("fetch");
        logWarn("token poll failed:", { message, transient });
        return {
            type: "failed",
            error: message,
            fatal: !transient,
        };
    }
}
/**
 * Performs single token refresh attempt
 * @param {string} refreshToken - Refresh token to use
 * @returns {Promise<Object>} Token result object with type: success|failed
 */
async function refreshAccessTokenOnce(refreshToken) {
    try {
        const res = await fetchWithTimeout(QWEN_OAUTH.TOKEN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: new URLSearchParams({
                grant_type: QWEN_OAUTH.GRANT_TYPE_REFRESH,
                client_id: QWEN_OAUTH.CLIENT_ID,
                refresh_token: refreshToken,
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            const lowered = text.toLowerCase();
            const isUnauthorized = res.status === 401 || res.status === 403;
            const isRateLimited = res.status === 429;
            // Identify transient errors (5xx, timeout, network)
            const transient = res.status >= 500 || lowered.includes("timed out") || lowered.includes("network");
            logError("token refresh failed:", { status: res.status, text });
            return {
                type: "failed",
                status: res.status,
                error: text || `HTTP ${res.status}`,
                fatal: isUnauthorized || isRateLimited || !transient,
            };
        }
        const json = await res.json();
        if (LOGGING_ENABLED) {
            logInfo("Token refresh response received:", {
                has_access_token: !!json.access_token,
                has_refresh_token: !!json.refresh_token,
                expires_in: json.expires_in,
                resource_url: json.resource_url,
                all_fields: Object.keys(json),
            });
        }
        // Validate refresh response structure
        if (!validateTokenResponse(json, "refresh response")) {
            return {
                type: "failed",
                error: "invalid_refresh_response",
                description: "Refresh response missing required fields",
                fatal: true,
            };
        }
        json.resource_url = normalizeResourceUrl(json.resource_url);
        if (!json.resource_url) {
            logWarn("No valid resource_url in refresh response, will use default DashScope endpoint");
        }
        return {
            type: "success",
            access: json.access_token,
            refresh: json.refresh_token,
            expires: Date.now() + json.expires_in * 1000,
            resourceUrl: json.resource_url,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lowered = message.toLowerCase();
        // Identify transient errors that may succeed on retry
        const transient = lowered.includes("timed out") || lowered.includes("network") || lowered.includes("fetch");
        logError("token refresh error:", { message, transient });
        return {
            type: "failed",
            error: message,
            fatal: !transient,
        };
    }
}
/**
 * Refreshes access token using refresh token with lock coordination
 * Implements retry logic for transient failures
 * @param {string} refreshToken - Refresh token to use
 * @returns {Promise<Object>} Token result object with type: success|failed
 */
export async function refreshAccessToken(refreshToken) {
    // Acquire lock to prevent concurrent refresh operations
    const lockPath = await acquireTokenLock();
    try {
        // Check if another process already refreshed the token
        const latest = loadStoredToken();
        if (latest && !isTokenExpired(latest.expiry_date)) {
            return buildTokenSuccessFromStored(latest);
        }
        // Use latest refresh token if available
        const effectiveRefreshToken = latest?.refresh_token || refreshToken;
        // Retry loop for transient failures
        for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
            const result = await refreshAccessTokenOnce(effectiveRefreshToken);
            if (result.type === "success") {
                saveToken(result);
                return result;
            }
            // Non-retryable errors: 401/403 (unauthorized)
            if (result.status === 401 || result.status === 403) {
                logError(`Refresh token rejected (${result.status}), re-authentication required`);
                clearStoredToken();
                return { type: "failed", status: result.status, error: "refresh_token_rejected", fatal: true };
            }
            // Non-retryable errors: 429 (rate limited)
            if (result.status === 429) {
                logError("Token refresh rate-limited (429), aborting retries");
                return { type: "failed", status: 429, error: "rate_limited", fatal: true };
            }
            // Non-retryable errors: fatal flag set
            if (result.fatal) {
                logError("Token refresh failed with fatal error", result);
                return result;
            }
            // Retry transient failures
            if (attempt < MAX_REFRESH_RETRIES) {
                if (LOGGING_ENABLED) {
                    logInfo(`Token refresh transient failure, retrying attempt ${attempt + 2}/${MAX_REFRESH_RETRIES + 1}...`);
                }
                await sleep(REFRESH_RETRY_DELAY_MS);
            }
        }
        logError("Token refresh failed after retry limit");
        return { type: "failed", error: "refresh_failed" };
    }
    finally {
        // Always release lock
        releaseTokenLock(lockPath);
    }
}
/**
 * Generates PKCE challenge and verifier for OAuth flow
 * @returns {Promise<{challenge: string, verifier: string}>} PKCE challenge and verifier pair
 */
export async function createPKCE() {
    const { challenge, verifier } = await generatePKCE();
    return { challenge, verifier };
}
/**
 * Loads stored token from disk with legacy migration
 * @returns {Object|null} Stored token data or null if not found/invalid
 */
export function loadStoredToken() {
    // Migrate legacy token if needed
    migrateLegacyTokenIfNeeded();
    const tokenPath = getTokenPath();
    if (!existsSync(tokenPath)) {
        return null;
    }
    try {
        const content = readFileSync(tokenPath, "utf-8");
        const parsed = JSON.parse(content);
        const normalized = toStoredTokenData(parsed);
        if (!normalized) {
            logWarn("Invalid token data, re-authentication required");
            return null;
        }
        // Check if token file needs format update
        const needsRewrite = typeof parsed.expiry_date !== "number" ||
            typeof parsed.token_type !== "string" ||
            typeof parsed.expires === "number" ||
            parsed.resource_url !== normalized.resource_url;
        if (needsRewrite) {
            try {
                writeStoredTokenData(normalized);
            }
            catch (rewriteError) {
                logWarn("Failed to normalize token file format:", rewriteError);
            }
        }
        return normalized;
    }
    catch (error) {
        logError("Failed to load token:", error);
        return null;
    }
}
/**
 * Clears stored token from both current and legacy paths
 */
export function clearStoredToken() {
    const targets = [getTokenPath(), getLegacyTokenPath()];
    for (const tokenPath of targets) {
        if (!existsSync(tokenPath)) {
            continue;
        }
        try {
            unlinkSync(tokenPath);
            logWarn(`Deleted token file: ${tokenPath}`);
        }
        catch (error) {
            logError("Unable to delete token file:", { tokenPath, error });
        }
    }
}
/**
 * Saves token result to disk
 * @param {{ type: string, access: string, refresh: string, expires: number, resourceUrl?: string }} tokenResult - Token result from OAuth flow
 * @throws {Error} If token result is invalid or write fails
 */
export function saveToken(tokenResult) {
    if (tokenResult.type !== "success") {
        throw new Error("Cannot save non-success token result");
    }
    const tokenData = {
        access_token: tokenResult.access,
        refresh_token: tokenResult.refresh,
        token_type: "Bearer",
        expiry_date: tokenResult.expires,
        resource_url: normalizeResourceUrl(tokenResult.resourceUrl),
    };
    try {
        writeStoredTokenData(tokenData);
    }
    catch (error) {
        logError("Failed to save token:", error);
        throw error;
    }
}

function buildRuntimeAccountResponse(account, healthyCount, totalCount, accessToken, resourceUrl) {
    return {
        accountId: account.id,
        accessToken,
        resourceUrl: resourceUrl || account.resource_url,
        exhaustedUntil: account.exhaustedUntil || 0,
        healthyAccountCount: healthyCount,
        totalAccountCount: totalCount,
    };
}

export async function upsertOAuthAccount(tokenResult, options = {}) {
    const tokenData = normalizeTokenResultToStored(tokenResult);
    if (!tokenData) {
        return null;
    }
    migrateLegacyTokenToAccountsIfNeeded();
    const accountKey = options.accountKey || deriveAccountKeyFromToken(tokenData);
    let selectedId = null;
    await withAccountsStoreLock((store) => {
        const now = Date.now();
        let index = -1;
        // forceNew: bo qua match, luon tao account moi (dung cho "Add another account")
        if (!options.forceNew) {
            if (typeof options.accountId === "string" && options.accountId.length > 0) {
                index = store.accounts.findIndex(account => account.id === options.accountId);
            }
            if (index < 0 && accountKey) {
                index = store.accounts.findIndex(account => account.accountKey === accountKey);
            }
            if (index < 0) {
                index = store.accounts.findIndex(account => account.token?.refresh_token === tokenData.refresh_token);
            }
        }
        if (index < 0) {
            const newId = typeof options.accountId === "string" && options.accountId.length > 0
                ? options.accountId
                : `acct_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
            store.accounts.push(buildAccountEntry(tokenData, newId, accountKey));
            index = store.accounts.length - 1;
        }
        const target = store.accounts[index];
        target.token = tokenData;
        target.resource_url = tokenData.resource_url;
        target.exhaustedUntil = 0;
        target.lastErrorCode = undefined;
        target.updatedAt = now;
        if (!target.createdAt || !Number.isFinite(target.createdAt)) {
            target.createdAt = now;
        }
        if (accountKey) {
            target.accountKey = accountKey;
        }
        selectedId = target.id;
        if (options.setActive || !store.activeAccountId) {
            store.activeAccountId = target.id;
        }
        return store;
    });
    if (!selectedId) {
        return null;
    }
    if (options.setActive) {
        return getActiveOAuthAccount({ allowExhausted: true, preferredAccountId: selectedId });
    }
    return getActiveOAuthAccount({ allowExhausted: true });
}

export async function getActiveOAuthAccount(options = {}) {
    migrateLegacyTokenToAccountsIfNeeded();
    const preferredAccountId = typeof options.preferredAccountId === "string" && options.preferredAccountId.length > 0
        ? options.preferredAccountId
        : null;
    const attemptedAuthRejected = new Set();
    for (; ;) {
        const lockPath = await acquireAccountsLock();
        let selected = null;
        let dirty = false;
        try {
            const store = loadAccountsStoreData();
            const now = Date.now();
            if (store.accounts.length === 0) {
                return null;
            }
            if (attemptedAuthRejected.size === 0 && preferredAccountId) {
                const exists = store.accounts.some(account => account.id === preferredAccountId);
                if (exists && store.activeAccountId !== preferredAccountId) {
                    store.activeAccountId = preferredAccountId;
                    dirty = true;
                }
            }
            let active = store.accounts.find(account => account.id === store.activeAccountId);
            if (!active) {
                active = store.accounts[0];
                store.activeAccountId = active.id;
                dirty = true;
            }
            const activeHealthy = !(typeof active.exhaustedUntil === "number" && active.exhaustedUntil > now);
            if (!activeHealthy && !options.allowExhausted) {
                const replacement = pickNextHealthyAccount(store, new Set(), now);
                if (!replacement) {
                    return null;
                }
                if (store.activeAccountId !== replacement.id) {
                    store.activeAccountId = replacement.id;
                    dirty = true;
                }
                active = replacement;
            }
            const healthyCount = countHealthyAccounts(store, now);
            selected = {
                account: { ...active },
                healthyCount,
                totalCount: store.accounts.length,
            };
            if (dirty) {
                writeAccountsStoreData(store);
            }
        }
        finally {
            releaseAccountsLock(lockPath);
        }
        if (!selected) {
            return null;
        }
        if (options.requireHealthy && selected.account.exhaustedUntil > Date.now()) {
            return null;
        }
        try {
            syncAccountToLegacyTokenFile(selected.account);
        }
        catch (error) {
            logWarn("Failed to sync active account token to oauth_creds.json", error);
            return null;
        }
        const valid = await getValidTokenDetailed({ clearOnFailure: false });
        if (valid.type === "success") {
            const latest = loadStoredToken();
            if (latest) {
                try {
                    await withAccountsStoreLock((store) => {
                        const target = store.accounts.find(account => account.id === selected.account.id);
                        if (!target) {
                            return store;
                        }
                        target.token = latest;
                        target.resource_url = latest.resource_url;
                        target.updatedAt = Date.now();
                        return store;
                    });
                }
                catch (error) {
                    logWarn("Failed to update account token from refreshed legacy token", error);
                }
            }
            return buildRuntimeAccountResponse(selected.account, selected.healthyCount, selected.totalCount, valid.accessToken, valid.resourceUrl);
        }
        if (valid.type !== "auth_rejected") {
            return null;
        }
        attemptedAuthRejected.add(selected.account.id);
        if (attemptedAuthRejected.size >= selected.totalCount) {
            if (LOGGING_ENABLED) {
                logWarn("All OAuth accounts rejected with auth_invalid, re-authentication required", {
                    attempted: attemptedAuthRejected.size,
                    total: selected.totalCount,
                });
            }
            return null;
        }
        let switchedToHealthy = false;
        try {
            await withAccountsStoreLock((store) => {
                const now = Date.now();
                const target = store.accounts.find(account => account.id === selected.account.id);
                if (!target) {
                    return store;
                }
                target.exhaustedUntil = now + getQuotaCooldownMs();
                target.lastErrorCode = "auth_invalid";
                target.updatedAt = now;
                const next = pickNextHealthyAccount(store, attemptedAuthRejected, now);
                if (next) {
                    store.activeAccountId = next.id;
                    switchedToHealthy = true;
                }
                return store;
            });
        }
        catch (error) {
            logWarn("Failed to switch OAuth account after auth_invalid", error);
            return null;
        }
        if (!switchedToHealthy) {
            if (LOGGING_ENABLED) {
                logWarn("No healthy OAuth account available after auth_invalid", {
                    accountID: selected.account.id,
                    attempted: attemptedAuthRejected.size,
                    total: selected.totalCount,
                });
            }
            return null;
        }
    }
}

export async function markOAuthAccountQuotaExhausted(accountId, errorCode = "insufficient_quota") {
    if (typeof accountId !== "string" || accountId.length === 0) {
        return null;
    }
    migrateLegacyTokenToAccountsIfNeeded();
    const cooldownMs = getQuotaCooldownMs();
    let outcome = null;
    await withAccountsStoreLock((store) => {
        const now = Date.now();
        const target = store.accounts.find(account => account.id === accountId);
        if (!target) {
            return store;
        }
        target.exhaustedUntil = now + cooldownMs;
        target.lastErrorCode = errorCode;
        target.updatedAt = now;
        if (store.activeAccountId === target.id) {
            const next = pickNextHealthyAccount(store, new Set([target.id]), now);
            if (next) {
                store.activeAccountId = next.id;
            }
        }
        outcome = {
            accountId: target.id,
            exhaustedUntil: target.exhaustedUntil,
            healthyAccountCount: countHealthyAccounts(store, now),
            totalAccountCount: store.accounts.length,
        };
        return store;
    });
    return outcome;
}

export async function switchToNextHealthyOAuthAccount(excludedAccountIds = []) {
    migrateLegacyTokenToAccountsIfNeeded();
    const excluded = new Set(Array.isArray(excludedAccountIds)
        ? excludedAccountIds.filter(id => typeof id === "string" && id.length > 0)
        : []);
    let switchedId = null;
    await withAccountsStoreLock((store) => {
        const next = pickNextHealthyAccount(store, excluded, Date.now());
        if (!next) {
            return store;
        }
        store.activeAccountId = next.id;
        switchedId = next.id;
        return store;
    });
    if (!switchedId) {
        return null;
    }
    return getActiveOAuthAccount({
        allowExhausted: false,
        requireHealthy: true,
        preferredAccountId: switchedId,
    });
}

/**
 * Checks if token is expired (with buffer)
 * @param {number} expiresAt - Token expiry timestamp in milliseconds
 * @returns {boolean} True if token is expired or expiring soon
 */
export function isTokenExpired(expiresAt) {
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS;
}

async function getValidTokenDetailed(options = {}) {
    const clearOnFailure = options.clearOnFailure === true;
    const stored = loadStoredToken();
    if (!stored) {
        return { type: "missing" };
    }
    if (!isTokenExpired(stored.expiry_date)) {
        return {
            type: "success",
            accessToken: stored.access_token,
            resourceUrl: stored.resource_url,
        };
    }
    if (LOGGING_ENABLED) {
        logInfo("Token expired, refreshing...");
    }
    const refreshResult = await refreshAccessToken(stored.refresh_token);
    if (refreshResult.type === "success") {
        return {
            type: "success",
            accessToken: refreshResult.access,
            resourceUrl: refreshResult.resourceUrl,
        };
    }
    const status = typeof refreshResult.status === "number" ? refreshResult.status : undefined;
    const isAuthRejected = status === 401 ||
        status === 403 ||
        refreshResult.error === "refresh_token_rejected";
    if (clearOnFailure) {
        clearStoredToken();
    }
    if (isAuthRejected) {
        return {
            type: "auth_rejected",
            status,
            error: refreshResult.error || "refresh_token_rejected",
        };
    }
    return {
        type: "transient_or_unknown",
        status,
        error: refreshResult.error || "refresh_failed",
    };
}

/**
 * Gets valid access token, refreshing if expired
 * @returns {Promise<{ accessToken: string, resourceUrl?: string }|null>} Valid token or null if unavailable
 */
export async function getValidToken() {
    const result = await getValidTokenDetailed({ clearOnFailure: true });
    if (result.type !== "success") {
        logError("Token refresh failed, re-authentication required");
        return null;
    }
    return {
        accessToken: result.accessToken,
        resourceUrl: result.resourceUrl,
    };
}

/**
 * Constructs DashScope API base URL from resource_url
 * @param {string} [resourceUrl] - Resource URL from token (optional)
 * @returns {string} DashScope API base URL
 */
export function getApiBaseUrl(resourceUrl) {
    if (resourceUrl) {
        try {
            const normalizedResourceUrl = normalizeResourceUrl(resourceUrl);
            if (!normalizedResourceUrl) {
                logWarn("Invalid resource_url, using default DashScope endpoint");
                return DEFAULT_QWEN_BASE_URL;
            }
            const url = new URL(normalizedResourceUrl);
            if (!url.protocol.startsWith("http")) {
                logWarn("Invalid resource_url protocol, using default DashScope endpoint");
                return DEFAULT_QWEN_BASE_URL;
            }
            // Ensure URL ends with /v1 suffix
            let baseUrl = normalizedResourceUrl.replace(/\/$/, "");
            const suffix = "/v1";
            if (!baseUrl.endsWith(suffix)) {
                baseUrl = `${baseUrl}${suffix}`;
            }
            if (LOGGING_ENABLED) {
                logInfo("Constructed DashScope base URL from resource_url:", baseUrl);
            }
            return baseUrl;
        }
        catch (error) {
            logWarn("Invalid resource_url format, using default DashScope endpoint:", error);
            return DEFAULT_QWEN_BASE_URL;
        }
    }
    if (LOGGING_ENABLED) {
        logInfo("No resource_url provided, using default DashScope endpoint");
    }
    return DEFAULT_QWEN_BASE_URL;
}
//# sourceMappingURL=auth.js.map
