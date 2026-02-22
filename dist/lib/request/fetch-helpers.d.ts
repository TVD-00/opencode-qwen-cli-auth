/**
 * Helper functions for the custom fetch implementation
 * These functions break down the complex fetch logic into manageable, testable units
 */
/**
 * Build headers for Qwen API request (OAuth)
 * @param accessToken - OAuth access token
 * @param resourceUrl - Resource URL to determine if DashScope headers are needed
 * @returns Request headers
 */
export declare function buildHeaders(accessToken: string, resourceUrl?: string): Record<string, string>;
/**
 * Construct Qwen Portal API URL from base URL and request path
 * @param url - Original request URL
 * @param baseUrl - Portal API base URL from token
 * @returns Constructed URL with correct base
 */
export declare function rewriteUrl(url: string, baseUrl: string): string;
//# sourceMappingURL=fetch-helpers.d.ts.map