/**
 * @fileoverview Constants for Qwen OAuth Plugin
 * Centralized configuration for OAuth endpoints, headers, error codes, and other constants
 * @license MIT
 */
/** Plugin identifier for logging and debugging */
export declare const PLUGIN_NAME: "qwen-oauth-plugin";
/**
 * Provider ID for opencode configuration
 * Used in model references like qwen-code/coder-model
 */
export declare const PROVIDER_ID: "qwen-code";
/**
 * Dummy API key placeholder
 * Actual authentication is handled via OAuth flow, not API key
 */
export declare const DUMMY_API_KEY: "qwen-oauth";
/**
 * Default Qwen DashScope base URL (fallback if resource_url is missing)
 * Note: This plugin is for OAuth authentication only. For API key authentication,
 * use OpenCode's built-in DashScope support.
 *
 * IMPORTANT: OAuth endpoints use /api/v1, DashScope OpenAI-compatible uses /compatible-mode/v1
 * - OAuth endpoints: /api/v1/oauth2/ (for authentication)
 * - Chat API: /v1/ (for completions)
 *
 * @constant {string}
 */
export declare const DEFAULT_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1";
/**
 * Qwen OAuth endpoints and configuration
 * Source: Qwen Code CLI (https://github.com/QwenLM/qwen-code)
 * @namespace
 */
export declare const QWEN_OAUTH: {
    /** OAuth 2.0 Device Code endpoint */
    readonly DEVICE_CODE_URL: "https://chat.qwen.ai/api/v1/oauth2/device/code";
    /** OAuth 2.0 Token endpoint */
    readonly TOKEN_URL: "https://chat.qwen.ai/api/v1/oauth2/token";
    /**
     * Qwen OAuth Client ID
     * This is a public client ID used for OAuth Device Authorization Grant flow (RFC 8628)
     * @constant {string}
     */
    readonly CLIENT_ID: "f0304373b74a44d2b584a3fb70ca9e56";
    /** OAuth scopes requested: openid, profile, email, and model completion access */
    readonly SCOPE: "openid profile email model.completion";
    /** OAuth 2.0 Device Code grant type (RFC 8628) */
    readonly GRANT_TYPE_DEVICE: "urn:ietf:params:oauth:grant-type:device_code";
    /** OAuth 2.0 Refresh Token grant type */
    readonly GRANT_TYPE_REFRESH: "refresh_token";
};
/**
 * HTTP Status Codes for error handling
 * @namespace
 */
export declare const HTTP_STATUS: {
    readonly OK: 200;
    readonly BAD_REQUEST: 400;
    readonly UNAUTHORIZED: 401;
    readonly FORBIDDEN: 403;
    readonly TOO_MANY_REQUESTS: 429;
};
/**
 * DashScope headers for OAuth authentication
 * Note: OAuth requires X-DashScope-AuthType to indicate qwen-oauth authentication
 * @namespace
 */
export declare const PORTAL_HEADERS: {
    /** Header name for auth type specification */
    readonly AUTH_TYPE: "X-DashScope-AuthType";
    /** Header value for qwen-oauth authentication */
    readonly AUTH_TYPE_VALUE: "qwen-oauth";
};
/**
 * Device flow polling configuration
 * Controls backoff strategy for OAuth token polling
 * @namespace
 */
export declare const DEVICE_FLOW: {
    /** Initial polling interval in milliseconds */
    readonly INITIAL_POLL_INTERVAL: 2000;
    /** Maximum polling interval in milliseconds */
    readonly MAX_POLL_INTERVAL: 10000;
    /** Backoff multiplier for exponential backoff */
    readonly BACKOFF_MULTIPLIER: 1.5;
};
/**
 * Error messages for user-facing errors
 * @namespace
 */
export declare const ERROR_MESSAGES: {
    readonly TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required";
    readonly DEVICE_AUTH_TIMEOUT: "Device authorization timed out";
    readonly DEVICE_AUTH_DENIED: "User denied authorization";
    readonly REQUEST_PARSE_ERROR: "Error parsing request";
    readonly NO_RESOURCE_URL: "No resource_url in token response, using default";
};
/**
 * OAuth error codes from RFC 8628 Device Flow
 * @namespace
 */
export declare const OAUTH_ERRORS: {
    /** User has not yet authorized the device code */
    readonly AUTHORIZATION_PENDING: "authorization_pending";
    /** Server requests slower polling (slow_down error) */
    readonly SLOW_DOWN: "slow_down";
    /** User denied the authorization request */
    readonly ACCESS_DENIED: "access_denied";
    /** Device code has expired */
    readonly EXPIRED_TOKEN: "expired_token";
};
/**
 * Log stages for request logging
 * Used for debugging and tracing request lifecycle
 * @namespace
 */
export declare const LOG_STAGES: {
    readonly BEFORE_TRANSFORM: "before-transform";
    readonly AFTER_TRANSFORM: "after-transform";
    readonly RESPONSE: "response";
    readonly ERROR_RESPONSE: "error-response";
    readonly DEVICE_CODE_REQUEST: "device-code-request";
    readonly TOKEN_POLL: "token-poll";
};
/**
 * Platform-specific browser opener commands
 * Used for opening OAuth verification URL in default browser
 * @namespace
 */
export declare const PLATFORM_OPENERS: Record<string, string>;
/**
 * OAuth authorization labels for UI display
 * @namespace
 */
export declare const AUTH_LABELS: {
    /** Label shown in OpenCode auth provider selection */
    readonly OAUTH: "Qwen Code (qwen.ai OAuth)";
    /** Instructions shown to user during OAuth flow */
    readonly INSTRUCTIONS: "Visit the URL shown in your browser to complete authentication.";
};
/**
 * OAuth verification URI parameters
 * Used to construct complete verification URL with client identification
 * @namespace
 */
export declare const VERIFICATION_URI: {
    /** Query parameter key for client identification */
    readonly CLIENT_PARAM_KEY: "client=";
    /** Full query parameter for Qwen Code client */
    readonly CLIENT_PARAM_VALUE: "client=qwen-code";
};
/**
 * Token refresh buffer in milliseconds
 * Tokens are refreshed 30 minutes before expiry to avoid race conditions
 * and reduce unnecessary refresh attempts during active sessions
 * @constant {number}
 */
export declare const TOKEN_REFRESH_BUFFER_MS: number;
/**
 * Stream processing configuration
 * @namespace
 */
export declare const STREAM_CONFIG: {
    /** Maximum buffer size for SSE pass-through mode (1MB) */
    readonly MAX_BUFFER_SIZE: number;
};
//# sourceMappingURL=constants.d.ts.map