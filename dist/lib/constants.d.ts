/**
 * Constants for Qwen OAuth Plugin
 */
/** Plugin identifier */
export declare const PLUGIN_NAME = "qwen-oauth-plugin";
/** Provider ID for opencode configuration (used in model references like qwen-code/coder-model) */
export declare const PROVIDER_ID = "qwen-code";
/** Dummy API key (actual auth via OAuth) */
export declare const DUMMY_API_KEY = "qwen-oauth";
/**
 * Default Qwen Portal API base URL (fallback if resource_url is missing)
 * Note: This plugin is for OAuth authentication only. For API key authentication,
 * use OpenCode's built-in DashScope support.
 *
 * IMPORTANT: Portal API uses /v1 path (not /api/v1)
 * - OAuth endpoints: /api/v1/oauth2/ (for authentication)
 * - Chat API: /v1/ (for completions)
 */
export declare const DEFAULT_QWEN_BASE_URL = "https://portal.qwen.ai/v1";
/** Qwen OAuth endpoints and configuration */
export declare const QWEN_OAUTH: {
    readonly DEVICE_CODE_URL: "https://chat.qwen.ai/api/v1/oauth2/device/code";
    readonly TOKEN_URL: "https://chat.qwen.ai/api/v1/oauth2/token";
    /**
     * Qwen OAuth Client ID
     * Source: Qwen Code CLI (https://github.com/QwenLM/qwen-code)
     * This is a public client ID used for OAuth Device Authorization Grant flow (RFC 8628)
     */
    readonly CLIENT_ID: "f0304373b74a44d2b584a3fb70ca9e56";
    readonly SCOPE: "openid profile email model.completion";
    readonly GRANT_TYPE_DEVICE: "urn:ietf:params:oauth:grant-type:device_code";
    readonly GRANT_TYPE_REFRESH: "refresh_token";
};
/** HTTP Status Codes */
export declare const HTTP_STATUS: {
    readonly OK: 200;
    readonly BAD_REQUEST: 400;
    readonly UNAUTHORIZED: 401;
    readonly FORBIDDEN: 403;
    readonly TOO_MANY_REQUESTS: 429;
};
/**
 * Portal API headers
 * Note: Portal API (OAuth) requires special header to indicate OAuth authentication
 */
export declare const PORTAL_HEADERS: {
    readonly AUTH_TYPE: "X-DashScope-AuthType";
    readonly AUTH_TYPE_VALUE: "qwen-oauth";
};
/** Device flow polling configuration */
export declare const DEVICE_FLOW: {
    readonly INITIAL_POLL_INTERVAL: 2000;
    readonly MAX_POLL_INTERVAL: 10000;
    readonly BACKOFF_MULTIPLIER: 1.5;
};
/** Error messages */
export declare const ERROR_MESSAGES: {
    readonly TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required";
    readonly DEVICE_AUTH_TIMEOUT: "Device authorization timed out";
    readonly DEVICE_AUTH_DENIED: "User denied authorization";
    readonly REQUEST_PARSE_ERROR: "Error parsing request";
    readonly NO_RESOURCE_URL: "No resource_url in token response, using default";
};
/** OAuth error codes */
export declare const OAUTH_ERRORS: {
    readonly AUTHORIZATION_PENDING: "authorization_pending";
    readonly SLOW_DOWN: "slow_down";
    readonly ACCESS_DENIED: "access_denied";
    readonly EXPIRED_TOKEN: "expired_token";
};
/** Log stages for request logging */
export declare const LOG_STAGES: {
    readonly BEFORE_TRANSFORM: "before-transform";
    readonly AFTER_TRANSFORM: "after-transform";
    readonly RESPONSE: "response";
    readonly ERROR_RESPONSE: "error-response";
    readonly DEVICE_CODE_REQUEST: "device-code-request";
    readonly TOKEN_POLL: "token-poll";
};
/** Platform-specific browser opener commands */
export declare const PLATFORM_OPENERS: {
    readonly darwin: "open";
    readonly win32: "start";
    readonly linux: "xdg-open";
};
/** OAuth authorization labels */
export declare const AUTH_LABELS: {
    readonly OAUTH: "Qwen Code (qwen.ai OAuth)";
    readonly INSTRUCTIONS: "Visit the URL shown in your browser to complete authentication.";
};
/** OAuth verification URI parameters */
export declare const VERIFICATION_URI: {
    /** Query parameter key for client identification */
    readonly CLIENT_PARAM_KEY: "client=";
    /** Full query parameter for Qwen Code client */
    readonly CLIENT_PARAM_VALUE: "client=qwen-code";
};
/** Token refresh buffer (refresh 5 minutes before expiry) */
export declare const TOKEN_REFRESH_BUFFER_MS: number;
/** Stream processing configuration */
export declare const STREAM_CONFIG: {
    /** Maximum buffer size for SSE pass-through mode (1MB) */
    readonly MAX_BUFFER_SIZE: number;
};
//# sourceMappingURL=constants.d.ts.map
