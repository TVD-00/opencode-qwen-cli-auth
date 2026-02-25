/**
 * @fileoverview Constants for Qwen OAuth Plugin
 * Centralized configuration for OAuth endpoints, headers, error codes, and other constants
 * @license MIT
 */

/** Plugin identifier for logging and debugging */
export const PLUGIN_NAME = "qwen-oauth-plugin";

/**
 * Provider ID for opencode configuration
 * Used in model references like qwen-code/coder-model
 */
export const PROVIDER_ID = "qwen-code";

/**
 * Dummy API key placeholder
 * Actual authentication is handled via OAuth flow, not API key
 */
export const DUMMY_API_KEY = "qwen-oauth";

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
// NOTE:
// qwen-code (official CLI) defaults to DashScope OpenAI-compatible endpoint when
// `resource_url` is missing. This is required for the free OAuth flow to behave
// the same as the CLI.
export const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * Qwen OAuth endpoints and configuration
 * Source: Qwen Code CLI (https://github.com/QwenLM/qwen-code)
 * @namespace
 */
export const QWEN_OAUTH = {
    /** OAuth 2.0 Device Code endpoint */
    DEVICE_CODE_URL: "https://chat.qwen.ai/api/v1/oauth2/device/code",
    /** OAuth 2.0 Token endpoint */
    TOKEN_URL: "https://chat.qwen.ai/api/v1/oauth2/token",
    /**
     * Qwen OAuth Client ID
     * This is a public client ID used for OAuth Device Authorization Grant flow (RFC 8628)
     * @constant {string}
     */
    CLIENT_ID: "f0304373b74a44d2b584a3fb70ca9e56",
    /** OAuth scopes requested: openid, profile, email, and model completion access */
    SCOPE: "openid profile email model.completion",
    /** OAuth 2.0 Device Code grant type (RFC 8628) */
    GRANT_TYPE_DEVICE: "urn:ietf:params:oauth:grant-type:device_code",
    /** OAuth 2.0 Refresh Token grant type */
    GRANT_TYPE_REFRESH: "refresh_token",
};

/**
 * HTTP Status Codes for error handling
 * @namespace
 */
export const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    TOO_MANY_REQUESTS: 429,
};

/**
 * DashScope headers for OAuth authentication
 * Note: OAuth requires X-DashScope-AuthType to indicate qwen-oauth authentication
 * @namespace
 */
export const PORTAL_HEADERS = {
    /** Header name for auth type specification */
    AUTH_TYPE: "X-DashScope-AuthType",
    /** Header value for qwen-oauth authentication */
    AUTH_TYPE_VALUE: "qwen-oauth",
};

/**
 * Device flow polling configuration
 * Controls backoff strategy for OAuth token polling
 * @namespace
 */
export const DEVICE_FLOW = {
    /** Initial polling interval in milliseconds */
    INITIAL_POLL_INTERVAL: 2000, // 2 seconds
    /** Maximum polling interval in milliseconds */
    MAX_POLL_INTERVAL: 10000, // 10 seconds
    /** Backoff multiplier for exponential backoff */
    BACKOFF_MULTIPLIER: 1.5,
};

/**
 * Error messages for user-facing errors
 * @namespace
 */
export const ERROR_MESSAGES = {
    TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required",
    DEVICE_AUTH_TIMEOUT: "Device authorization timed out",
    DEVICE_AUTH_DENIED: "User denied authorization",
    REQUEST_PARSE_ERROR: "Error parsing request",
    NO_RESOURCE_URL: "No resource_url in token response, using default",
};

/**
 * OAuth error codes from RFC 8628 Device Flow
 * @namespace
 */
export const OAUTH_ERRORS = {
    /** User has not yet authorized the device code */
    AUTHORIZATION_PENDING: "authorization_pending",
    /** Server requests slower polling (slow_down error) */
    SLOW_DOWN: "slow_down",
    /** User denied the authorization request */
    ACCESS_DENIED: "access_denied",
    /** Device code has expired */
    EXPIRED_TOKEN: "expired_token",
};

/**
 * Log stages for request logging
 * Used for debugging and tracing request lifecycle
 * @namespace
 */
export const LOG_STAGES = {
    BEFORE_TRANSFORM: "before-transform",
    AFTER_TRANSFORM: "after-transform",
    RESPONSE: "response",
    ERROR_RESPONSE: "error-response",
    DEVICE_CODE_REQUEST: "device-code-request",
    TOKEN_POLL: "token-poll",
};

/**
 * Platform-specific browser opener commands
 * Used for opening OAuth verification URL in default browser
 * @namespace
 */
export const PLATFORM_OPENERS = {
    darwin: "open",
    win32: "start",
    linux: "xdg-open",
};

/**
 * OAuth authorization labels for UI display
 * @namespace
 */
export const AUTH_LABELS = {
    /** Label shown in OpenCode auth provider selection */
    OAUTH: "Qwen Code (qwen.ai OAuth)",
    /** Instructions shown to user during OAuth flow */
    INSTRUCTIONS: "Visit the URL shown in your browser to complete authentication.",
};

/**
 * OAuth verification URI parameters
 * Used to construct complete verification URL with client identification
 * @namespace
 */
export const VERIFICATION_URI = {
    /** Query parameter key for client identification */
    CLIENT_PARAM_KEY: "client=",
    /** Full query parameter for Qwen Code client */
    CLIENT_PARAM_VALUE: "client=qwen-code",
};

/**
 * Token refresh buffer in milliseconds
 * Tokens are refreshed 30 seconds before expiry to avoid race conditions
 * @constant {number}
 */
export const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds

/**
 * Stream processing configuration
 * @namespace
 */
export const STREAM_CONFIG = {
    /** Maximum buffer size for SSE pass-through mode (1MB) */
    MAX_BUFFER_SIZE: 1024 * 1024,
};
