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
export function buildHeaders(accessToken, resourceUrl) {
    // For Qwen OAuth requests, include the DashScope auth type header unconditionally.
    // This header is required by Portal routing for OpenAI-compatible endpoints.
    const headers = {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-DashScope-AuthType": "qwen_oauth",
    };
    return headers;
}
/**
 * Construct Qwen Portal API URL from base URL and request path
 * @param url - Original request URL
 * @param baseUrl - Portal API base URL from token
 * @returns Constructed URL with correct base
 */
export function rewriteUrl(url, baseUrl) {
    // Parse URL, ho tro ca URL tuong doi bang cach dung base gia
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch (_) {
        // URL tuong doi (vd: /v1/chat/completions?stream=true)
        parsed = new URL(url, 'http://placeholder');
    }
    const base = baseUrl.replace(/\/+$/, ''); // trim trailing '/'
    let normalizedPath = parsed.pathname;
    // Tranh trung /v1 khi base da co /v1
    if (base.endsWith('/v1') && normalizedPath.startsWith('/v1')) {
        normalizedPath = normalizedPath.replace(/^\/v1/, '');
    }
    if (!normalizedPath.startsWith('/')) {
        normalizedPath = `/${normalizedPath}`;
    }
    // Giu nguyen query params (vd: ?stream=true&foo=1)
    const query = parsed.search || '';
    return `${base}${normalizedPath}${query}`;
}
//# sourceMappingURL=fetch-helpers.js.map