import type { Auth, Provider, Model } from "@opencode-ai/sdk";
/**
 * Headers type compatible with fetch API
 * Supports Headers object, array of tuples, or plain object
 * Also compatible with HeadersInit from DOM types
 */
export type HeadersInput = Headers | [string, string][] | Record<string, string> | {
    [key: string]: string | undefined;
};
/**
 * Plugin configuration from ~/.opencode/qwen/auth-config.json
 */
export interface PluginConfig {
    qwenMode?: boolean;
}
/**
 * User configuration structure from opencode.json
 */
export interface UserConfig {
    global: ConfigOptions;
    models: {
        [modelName: string]: {
            options?: ConfigOptions;
        };
    };
}
/**
 * Configuration options for model settings
 */
export interface ConfigOptions {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    [key: string]: unknown;
}
/**
 * PKCE challenge and verifier
 */
export interface PKCEPair {
    challenge: string;
    verifier: string;
}
/**
 * Device authorization response
 */
export interface DeviceAuthorizationResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval?: number;
}
/**
 * Token response from Qwen OAuth
 */
export interface QwenTokenResponse {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    resource_url?: string;
}
/**
 * Stored token data in ~/.opencode/qwen/oauth_token.json
 */
export interface StoredTokenData {
    access_token: string;
    refresh_token: string;
    expires: number;
    resource_url?: string;
}
/**
 * Token exchange success result
 */
export interface TokenSuccess {
    type: "success";
    access: string;
    refresh: string;
    expires: number;
    resourceUrl?: string;
}
/**
 * Token exchange failure result
 */
export interface TokenFailure {
    type: "failed";
}
/**
 * Token exchange pending result (device flow)
 */
export interface TokenPending {
    type: "pending";
}
/**
 * Token exchange slow down result (device flow)
 */
export interface TokenSlowDown {
    type: "slow_down";
}
/**
 * Token exchange expired result (device flow)
 */
export interface TokenExpired {
    type: "expired";
}
/**
 * Token exchange denied result (device flow)
 */
export interface TokenDenied {
    type: "denied";
}
/**
 * Token exchange result
 */
export type TokenResult = TokenSuccess | TokenFailure | TokenPending | TokenSlowDown | TokenExpired | TokenDenied;
/**
 * Message input item
 */
export interface InputItem {
    id?: string;
    type: string;
    role: string;
    content?: unknown;
    [key: string]: unknown;
}
/**
 * Chat message structure
 */
export interface ChatMessage {
    role: string;
    content: string;
    [key: string]: unknown;
}
/**
 * Request body structure
 */
export interface RequestBody {
    model: string;
    messages?: unknown[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    [key: string]: unknown;
}
/**
 * SSE event data structure
 */
export interface SSEEventData {
    type: string;
    response?: unknown;
    [key: string]: unknown;
}
/**
 * Cache metadata for Qwen Code instructions
 */
export interface CacheMetadata {
    etag: string | null;
    tag: string;
    lastChecked: number;
    url: string;
}
/**
 * GitHub release response for fetching latest release tags
 */
export interface GitHubRelease {
    tag_name: string;
    [key: string]: unknown;
}
/**
 * Standardized error response format
 */
export interface ErrorResponse {
    error: string;
    message: string;
    code?: string;
}
export type { Auth, Provider, Model };
//# sourceMappingURL=types.d.ts.map