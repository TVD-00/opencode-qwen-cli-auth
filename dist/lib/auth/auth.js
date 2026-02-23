import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { QWEN_OAUTH, DEFAULT_QWEN_BASE_URL, TOKEN_REFRESH_BUFFER_MS, VERIFICATION_URI } from "../constants.js";
import { getTokenPath, getConfigDir } from "../config.js";
import { logError, logWarn, logInfo, LOGGING_ENABLED } from "../logger.js";
// Maximum retry attempts when token refresh fails
const MAX_REFRESH_RETRIES = 2;
const REFRESH_RETRY_DELAY_MS = 1000;
/**
 * Normalize and validate resource_url from OAuth response
 * @param resourceUrl - Resource URL from token response
 * @returns Normalized URL or undefined if invalid
 */
function normalizeResourceUrl(resourceUrl) {
    if (!resourceUrl)
        return undefined;
    try {
        // Qwen returns resource_url without protocol (e.g., "portal.qwen.ai")
        // Normalize it by adding https:// if missing
        let normalizedUrl = resourceUrl;
        if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
            normalizedUrl = `https://${normalizedUrl}`;
        }
        // Validate the normalized URL
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
 * Validate token response fields
 * @param json - Token response JSON
 * @param context - Context for logging (e.g., "token response" or "refresh response")
 * @returns True if valid, false otherwise
 */
function validateTokenResponse(json, context) {
    // Check required fields
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
        logError(`${context} missing fields:`, json);
        return false;
    }
    // Validate expires_in is positive
    if (json.expires_in <= 0) {
        logError(`invalid expires_in value in ${context}:`, json.expires_in);
        return false;
    }
    return true;
}
/**
 * Request device authorization code
 * @param pkce - PKCE challenge/verifier pair
 * @returns Device authorization response with user code and verification URL
 */
export async function requestDeviceCode(pkce) {
    try {
        const res = await fetch(QWEN_OAUTH.DEVICE_CODE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
        if (!json.device_code || !json.user_code || !json.verification_uri) {
            logError("device code response missing fields:", json);
            return null;
        }
        // Ensure verification_uri_complete includes the client parameter
        // Qwen's OAuth server requires client=qwen-code for proper authentication
        if (!json.verification_uri_complete || !json.verification_uri_complete.includes(VERIFICATION_URI.CLIENT_PARAM_KEY)) {
            const baseUrl = json.verification_uri_complete || json.verification_uri;
            const separator = baseUrl.includes('?') ? '&' : '?';
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
 * Poll for token using device code
 * @param deviceCode - Device code from authorization response
 * @param verifier - PKCE verifier
 * @param interval - Polling interval in seconds (from device response)
 * @returns Token result or null if still pending
 */
export async function pollForToken(deviceCode, verifier, interval = 2) {
    try {
        const res = await fetch(QWEN_OAUTH.TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: QWEN_OAUTH.GRANT_TYPE_DEVICE,
                client_id: QWEN_OAUTH.CLIENT_ID,
                device_code: deviceCode,
                code_verifier: verifier,
            }),
        });
        if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            const error = json.error;
            // Handle expected errors
            if (error === "authorization_pending") {
                return { type: "pending" };
            }
            if (error === "slow_down") {
                return { type: "slow_down" };
            }
            if (error === "expired_token") {
                return { type: "expired" };
            }
            if (error === "access_denied") {
                return { type: "denied" };
            }
            logError("token poll failed:", { status: res.status, json });
            return { type: "failed" };
        }
        const json = await res.json();
        if (LOGGING_ENABLED) {
            // Log the full token response for debugging
            logInfo("Token response received:", {
                has_access_token: !!json.access_token,
                has_refresh_token: !!json.refresh_token,
                expires_in: json.expires_in,
                resource_url: json.resource_url,
                all_fields: Object.keys(json),
            });
        }
        // Validate token response fields
        if (!validateTokenResponse(json, "token response")) {
            return { type: "failed" };
        }
        // Validate and normalize resource_url if present
        json.resource_url = normalizeResourceUrl(json.resource_url);
        if (!json.resource_url) {
            logWarn("No valid resource_url in token response, will use default DashScope endpoint");
        }
        // At this point, validation ensures these fields exist
        return {
            type: "success",
            access: json.access_token,
            refresh: json.refresh_token,
            expires: Date.now() + json.expires_in * 1000,
            resourceUrl: json.resource_url, // Dynamic API base URL
        };
    }
    catch (error) {
        logError("token poll error:", error);
        return { type: "failed" };
    }
}
/**
 * Refresh access token using refresh token (single attempt, no retry)
 * @param refreshToken - Refresh token
 * @returns Token result
 */
async function refreshAccessTokenOnce(refreshToken) {
    try {
        const res = await fetch(QWEN_OAUTH.TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: QWEN_OAUTH.GRANT_TYPE_REFRESH,
                client_id: QWEN_OAUTH.CLIENT_ID,
                refresh_token: refreshToken,
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            logError("token refresh failed:", { status: res.status, text });
            return { type: "failed", status: res.status };
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
        // Validate token response fields
        if (!validateTokenResponse(json, "refresh response")) {
            return { type: "failed" };
        }
        // Validate and normalize resource_url if present
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
        logError("token refresh error:", error);
        return { type: "failed" };
    }
}
/**
 * Refresh access token with retry logic.
 * Retries up to MAX_REFRESH_RETRIES times with delay between attempts.
 * @param refreshToken - Refresh token
 * @returns Token result
 */
export async function refreshAccessToken(refreshToken) {
    for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
        const result = await refreshAccessTokenOnce(refreshToken);
        if (result.type === "success") {
            return result;
        }
        // If 401/403 error, refresh token was revoked, no need to retry
        if (result.status === 401 || result.status === 403) {
            logError("Refresh token rejected (" + result.status + "), re-authentication required");
            return { type: "failed" };
        }
        // If retries remaining, wait and try again
        if (attempt < MAX_REFRESH_RETRIES) {
            if (LOGGING_ENABLED) {
                logInfo(`Token refresh failed, retrying attempt ${attempt + 2}/${MAX_REFRESH_RETRIES + 1}...`);
            }
            await new Promise(resolve => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
        }
    }
    logError("Token refresh failed after " + (MAX_REFRESH_RETRIES + 1) + " attempts");
    return { type: "failed" };
}
/**
 * Generate PKCE challenge and verifier
 * @returns PKCE pair
 */
export async function createPKCE() {
    const { challenge, verifier } = await generatePKCE();
    return { challenge, verifier };
}
/**
 * Load stored token from disk
 * @returns Stored token data or null if not found
 */
export function loadStoredToken() {
    const tokenPath = getTokenPath();
    if (!existsSync(tokenPath)) {
        return null;
    }
    try {
        const content = readFileSync(tokenPath, "utf-8");
        const data = JSON.parse(content);
        // Validate required fields
        if (!data.access_token || !data.refresh_token || typeof data.expires !== "number") {
            logWarn("Invalid token data, re-authentication required");
            return null;
        }
        return data;
    }
    catch (error) {
        logError("Failed to load token:", error);
        return null;
    }
}
/**
 * Delete token stored on disk when token is no longer valid.
 */
export function clearStoredToken() {
    const tokenPath = getTokenPath();
    if (existsSync(tokenPath)) {
        try {
            unlinkSync(tokenPath);
            logWarn("Deleted old token, re-authentication required");
        }
        catch (error) {
            logError("Unable to delete token file:", error);
        }
    }
}
/**
 * Save token to disk
 * @param tokenResult - Token result from OAuth flow
 */
export function saveToken(tokenResult) {
    if (tokenResult.type !== "success") {
        throw new Error("Cannot save non-success token result");
    }
    const configDir = getConfigDir();
    // Ensure directory exists
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    const tokenData = {
        access_token: tokenResult.access,
        refresh_token: tokenResult.refresh,
        expires: tokenResult.expires,
        resource_url: tokenResult.resourceUrl,
    };
    const tokenPath = getTokenPath();
    try {
        writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2), {
            encoding: "utf-8",
            mode: 0o600, // Secure permissions
        });
    }
    catch (error) {
        logError("Failed to save token:", error);
        throw error;
    }
}
/**
 * Check if token is expired (with 5 minute buffer)
 * @param expiresAt - Expiration timestamp in milliseconds
 * @returns True if token is expired or will expire soon
 */
export function isTokenExpired(expiresAt) {
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS;
}
/**
 * Get valid access token, refreshing if necessary.
 * When refresh fails, delete old token so user knows re-authentication is needed.
 * @returns Access token and resource URL, or null if authentication required
 */
export async function getValidToken() {
    const stored = loadStoredToken();
    if (!stored) {
        return null; // No token, authentication required
    }
    // Token is still valid
    if (!isTokenExpired(stored.expires)) {
        return {
            accessToken: stored.access_token,
            resourceUrl: stored.resource_url,
        };
    }
    // Token expired, try refresh (has retry logic inside)
    if (LOGGING_ENABLED) {
        logInfo("Token expired, refreshing...");
    }
    const refreshResult = await refreshAccessToken(stored.refresh_token);
    if (refreshResult.type !== "success") {
        logError("Token refresh failed, re-authentication required");
        // Delete old token to avoid error loop
        clearStoredToken();
        return null;
    }
    // Save new token
    saveToken(refreshResult);
    return {
        accessToken: refreshResult.access,
        resourceUrl: refreshResult.resourceUrl,
    };
}
/**
 * Get Portal API base URL from token or use default
 * @param resourceUrl - Resource URL from token (optional)
 * @returns Portal API base URL
 *
 * IMPORTANT: Portal API uses /v1 path (not /api/v1)
 * - OAuth endpoints: /api/v1/oauth2/ (for authentication)
 * - Chat API: /v1/ (for completions)
 */
export function getApiBaseUrl(resourceUrl) {
    if (resourceUrl) {
        // Validate URL format
        try {
            const url = new URL(resourceUrl);
            if (!url.protocol.startsWith('http')) {
                logWarn('Invalid resource_url protocol, using default Portal API URL');
                return DEFAULT_QWEN_BASE_URL;
            }
            // Construct the Portal API endpoint from resource_url
            // Qwen returns "portal.qwen.ai" which should become "https://portal.qwen.ai/v1"
            // Remove trailing slash if present
            let baseUrl = resourceUrl.replace(/\/$/, "");
            // Add /v1 suffix if not already present
            const suffix = '/v1';
            if (!baseUrl.endsWith(suffix)) {
                baseUrl = `${baseUrl}${suffix}`;
            }
            if (LOGGING_ENABLED) {
                logInfo('Constructed Portal API base URL from resource_url:', baseUrl);
            }
            return baseUrl;
        }
        catch (error) {
            logWarn('Invalid resource_url format, using default Portal API URL:', error);
            return DEFAULT_QWEN_BASE_URL;
        }
    }
    // Fall back to default Portal API URL
    if (LOGGING_ENABLED) {
        logInfo('No resource_url provided, using default Portal API URL');
    }
    return DEFAULT_QWEN_BASE_URL;
}
//# sourceMappingURL=auth.js.map