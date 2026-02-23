/**
 * Constants for Qwen OAuth Plugin
 */
/** Plugin identifier */
export const PLUGIN_NAME = "qwen-oauth-plugin";
/** Provider ID for opencode configuration (used in model references like qwen-code/coder-model) */
export const PROVIDER_ID = "qwen-code";
/** Dummy API key (actual auth via OAuth) */
export const DUMMY_API_KEY = "qwen-oauth";
/**
 * Default Qwen Portal API base URL (fallback if resource_url is missing)
 * Note: This plugin is for OAuth authentication only. For API key authentication,
 * use OpenCode's built-in DashScope support.
 *
 * IMPORTANT: Portal API uses /v1 path (not /api/v1)
 * - OAuth endpoints: /api/v1/oauth2/ (for authentication)
 * - Chat API: /v1/ (for completions)
 */
export const DEFAULT_QWEN_BASE_URL = "https://portal.qwen.ai/v1";
/** Qwen OAuth endpoints and configuration */
export const QWEN_OAUTH = {
    DEVICE_CODE_URL: "https://chat.qwen.ai/api/v1/oauth2/device/code",
    TOKEN_URL: "https://chat.qwen.ai/api/v1/oauth2/token",
    /**
     * Qwen OAuth Client ID
     * Source: Qwen Code CLI (https://github.com/QwenLM/qwen-code)
     * This is a public client ID used for OAuth Device Authorization Grant flow (RFC 8628)
     */
    CLIENT_ID: "f0304373b74a44d2b584a3fb70ca9e56",
    SCOPE: "openid profile email model.completion",
    GRANT_TYPE_DEVICE: "urn:ietf:params:oauth:grant-type:device_code",
    GRANT_TYPE_REFRESH: "refresh_token",
};
/** HTTP Status Codes */
export const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    TOO_MANY_REQUESTS: 429,
};
/**
 * Portal API headers
 * Note: Portal API (OAuth) requires special header to indicate OAuth authentication
 */
export const PORTAL_HEADERS = {
    AUTH_TYPE: "X-DashScope-AuthType",
    AUTH_TYPE_VALUE: "qwen_oauth",
};
/** Device flow polling configuration */
export const DEVICE_FLOW = {
    INITIAL_POLL_INTERVAL: 2000, // 2 seconds
    MAX_POLL_INTERVAL: 10000, // 10 seconds
    BACKOFF_MULTIPLIER: 1.5,
};
/** Error messages */
export const ERROR_MESSAGES = {
    TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required",
    DEVICE_AUTH_TIMEOUT: "Device authorization timed out",
    DEVICE_AUTH_DENIED: "User denied authorization",
    REQUEST_PARSE_ERROR: "Error parsing request",
    NO_RESOURCE_URL: "No resource_url in token response, using default",
};
/** OAuth error codes */
export const OAUTH_ERRORS = {
    AUTHORIZATION_PENDING: "authorization_pending",
    SLOW_DOWN: "slow_down",
    ACCESS_DENIED: "access_denied",
    EXPIRED_TOKEN: "expired_token",
};
/** Log stages for request logging */
export const LOG_STAGES = {
    BEFORE_TRANSFORM: "before-transform",
    AFTER_TRANSFORM: "after-transform",
    RESPONSE: "response",
    ERROR_RESPONSE: "error-response",
    DEVICE_CODE_REQUEST: "device-code-request",
    TOKEN_POLL: "token-poll",
};
/** Platform-specific browser opener commands */
export const PLATFORM_OPENERS = {
    darwin: "open",
    win32: "start",
    linux: "xdg-open",
};
/** OAuth authorization labels */
export const AUTH_LABELS = {
    OAUTH: "Qwen Code (qwen.ai OAuth)",
    INSTRUCTIONS: "Visit the URL shown in your browser to complete authentication.",
};
/** OAuth verification URI parameters */
export const VERIFICATION_URI = {
    /** Query parameter key for client identification */
    CLIENT_PARAM_KEY: "client=",
    /** Full query parameter for Qwen Code client */
    CLIENT_PARAM_VALUE: "client=qwen-code",
};
/** Token refresh buffer (refresh 5 minutes before expiry) */
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
/** Stream processing configuration */
export const STREAM_CONFIG = {
    /** Maximum buffer size for SSE pass-through mode (1MB) */
    MAX_BUFFER_SIZE: 1024 * 1024,
};
//# sourceMappingURL=constants.js.map