import type { PKCEPair, DeviceAuthorizationResponse, TokenResult, StoredTokenData } from "../types.js";
/**
 * Request device authorization code
 * @param pkce - PKCE challenge/verifier pair
 * @returns Device authorization response with user code and verification URL
 */
export declare function requestDeviceCode(pkce: PKCEPair): Promise<DeviceAuthorizationResponse | null>;
/**
 * Poll for token using device code
 * @param deviceCode - Device code from authorization response
 * @param verifier - PKCE verifier
 * @param interval - Polling interval in seconds (from device response)
 * @returns Token result or null if still pending
 */
export declare function pollForToken(deviceCode: string, verifier: string, interval?: number): Promise<TokenResult>;
/**
 * Refresh access token using refresh token
 * @param refreshToken - Refresh token
 * @returns Token result
 */
export declare function refreshAccessToken(refreshToken: string): Promise<TokenResult>;
/**
 * Generate PKCE challenge and verifier
 * @returns PKCE pair
 */
export declare function createPKCE(): Promise<PKCEPair>;
/**
 * Load stored token from disk
 * @returns Stored token data or null if not found
 */
export declare function loadStoredToken(): StoredTokenData | null;
/**
 * Xoa token luu tren disk khi token khong con hop le
 */
export declare function clearStoredToken(): void;
/**
 * Save token to disk
 * @param tokenResult - Token result from OAuth flow
 */
export declare function saveToken(tokenResult: TokenResult): void;
/**
 * Check if token is expired (with 5 minute buffer)
 * @param expiresAt - Expiration timestamp in milliseconds
 * @returns True if token is expired or will expire soon
 */
export declare function isTokenExpired(expiresAt: number): boolean;
/**
 * Get valid access token, refreshing if necessary
 * @returns Access token and resource URL, or null if authentication required
 */
export declare function getValidToken(): Promise<{
    accessToken: string;
    resourceUrl?: string;
} | null>;
/**
 * Get Portal API base URL from token or use default
 * @param resourceUrl - Resource URL from token (optional)
 * @returns Portal API base URL
 *
 * IMPORTANT: Portal API uses /v1 path (not /api/v1)
 * - OAuth endpoints: /api/v1/oauth2/ (for authentication)
 * - Chat API: /v1/ (for completions)
 */
export declare function getApiBaseUrl(resourceUrl?: string): string;
//# sourceMappingURL=auth.d.ts.map