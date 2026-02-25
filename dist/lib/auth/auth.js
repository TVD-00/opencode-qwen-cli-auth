/**
 * @fileoverview OAuth authentication utilities for Qwen Plugin
 * Implements OAuth 2.0 Device Authorization Grant flow (RFC 8628)
 * Handles token storage, refresh, and validation
 * @license MIT
 */

import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, statSync } from "fs";
import { QWEN_OAUTH, DEFAULT_QWEN_BASE_URL, TOKEN_REFRESH_BUFFER_MS, VERIFICATION_URI } from "../constants.js";
import { getTokenPath, getQwenDir, getTokenLockPath, getLegacyTokenPath } from "../config.js";
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
/**
 * Acquires exclusive lock for token refresh to prevent concurrent refreshes
 * Uses file-based locking with exponential backoff retry strategy
 * @returns {Promise<string>} Lock file path if acquired successfully
 * @throws {Error} If lock cannot be acquired within timeout
 */
async function acquireTokenLock() {
    const lockPath = getTokenLockPath();
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
/**
 * Checks if token is expired (with buffer)
 * @param {number} expiresAt - Token expiry timestamp in milliseconds
 * @returns {boolean} True if token is expired or expiring soon
 */
export function isTokenExpired(expiresAt) {
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Gets valid access token, refreshing if expired
 * @returns {Promise<{ accessToken: string, resourceUrl?: string }|null>} Valid token or null if unavailable
 */
export async function getValidToken() {
    const stored = loadStoredToken();
    if (!stored) {
        return null;
    }
    // Return cached token if still valid
    if (!isTokenExpired(stored.expiry_date)) {
        return {
            accessToken: stored.access_token,
            resourceUrl: stored.resource_url,
        };
    }
    if (LOGGING_ENABLED) {
        logInfo("Token expired, refreshing...");
    }
    // Token expired, try to refresh
    const refreshResult = await refreshAccessToken(stored.refresh_token);
    if (refreshResult.type !== "success") {
        logError("Token refresh failed, re-authentication required");
        clearStoredToken();
        return null;
    }
    return {
        accessToken: refreshResult.access,
        resourceUrl: refreshResult.resourceUrl,
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
