/**
 * @fileoverview OAuth authentication utilities for Qwen Plugin
 * Implements OAuth 2.0 Device Authorization Grant flow (RFC 8628)
 * Handles token storage, refresh, and validation
 * @license MIT
 */
import type { StoredTokenData, PKCEPair, DeviceAuthorizationResponse, TokenResult, AccountResponse, OutcomeResponse } from "../types.js";
/**
 * Requests device code from Qwen OAuth server
 * Initiates OAuth 2.0 Device Authorization Grant flow
 * @param {{ challenge: string, verifier: string }} pkce - PKCE challenge and verifier
 * @returns {Promise<Object|null>} Device auth response or null on failure
 */
export declare function requestDeviceCode(pkce: PKCEPair): Promise<DeviceAuthorizationResponse | null>;
/**
 * Polls Qwen OAuth server for access token using device code
 * Implements OAuth 2.0 Device Flow polling with proper error handling
 * @param {string} deviceCode - Device code from requestDeviceCode
 * @param {string} verifier - PKCE code verifier
 * @param {number} [interval=2] - Polling interval in seconds
 * @returns {Promise<Object>} Token result object with type: success|pending|slow_down|failed|denied|expired
 */
export declare function pollForToken(deviceCode: string, verifier: string, interval?: number): Promise<TokenResult>;
/**
 * Refreshes access token using refresh token with lock coordination
 * Implements retry logic for transient failures
 * @param {string} refreshToken - Refresh token to use
 * @returns {Promise<Object>} Token result object with type: success|failed
 */
export declare function refreshAccessToken(refreshToken: string): Promise<TokenResult>;
/**
 * Generates PKCE challenge and verifier for OAuth flow
 * @returns {Promise<{challenge: string, verifier: string}>} PKCE challenge and verifier pair
 */
export declare function createPKCE(): Promise<PKCEPair>;
/**
 * Loads stored token from disk with legacy migration
 * @returns {Object|null} Stored token data or null if not found/invalid
 */
export declare function loadStoredToken(): StoredTokenData | null;
/**
 * Clears stored token from both current and legacy paths
 */
export declare function clearStoredToken(): void;
/**
 * Saves token result to disk
 * @param {{ type: string, access: string, refresh: string, expires: number, resourceUrl?: string }} tokenResult - Token result from OAuth flow
 * @throws {Error} If token result is invalid or write fails
 */
export declare function saveToken(tokenResult: TokenResult): void;
export declare function upsertOAuthAccount(tokenResult: TokenResult, options?: {
    accountId?: string;
    accountKey?: string;
    setActive?: boolean;
    forceNew?: boolean;
}): Promise<AccountResponse | null>;
export declare function getActiveOAuthAccount(options?: {
    allowExhausted?: boolean;
    requireHealthy?: boolean;
    preferredAccountId?: string;
}): Promise<AccountResponse | null>;
export declare function markOAuthAccountQuotaExhausted(accountId: string, errorCode?: string): Promise<OutcomeResponse | null>;
export declare function switchToNextHealthyOAuthAccount(excludedAccountIds?: string[]): Promise<AccountResponse | null>;
/**
 * Checks if token is expired (with buffer)
 * @param {number} expiresAt - Token expiry timestamp in milliseconds
 * @returns {boolean} True if token is expired or expiring soon
 */
export declare function isTokenExpired(expiresAt: number): boolean;
/**
 * Gets valid access token, refreshing if expired
 * @returns {Promise<{ accessToken: string, resourceUrl?: string }|null>} Valid token or null if unavailable
 */
export declare function getValidToken(): Promise<{
    accessToken: string;
    resourceUrl?: string;
} | null>;
/**
 * Constructs DashScope API base URL from resource_url
 * @param {string} [resourceUrl] - Resource URL from token (optional)
 * @returns {string} DashScope API base URL
 */
export declare function getApiBaseUrl(resourceUrl?: string): string;
//# sourceMappingURL=auth.d.ts.map