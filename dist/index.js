/**
 * Alibaba Qwen OAuth Authentication Plugin for opencode
 *
 * Simple plugin: handles OAuth login + provides apiKey/baseURL to SDK.
 * SDK handles streaming, headers, and request format.
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @repository https://github.com/TVD-00/opencode-qwen-cli-auth
 */
import { randomUUID } from "node:crypto";
import { createPKCE, requestDeviceCode, pollForToken, getApiBaseUrl, saveToken, refreshAccessToken, loadStoredToken, getValidToken } from "./lib/auth/auth.js";
import { PROVIDER_ID, AUTH_LABELS, DEVICE_FLOW, PORTAL_HEADERS } from "./lib/constants.js";
import { logError, logInfo, logWarn, LOGGING_ENABLED } from "./lib/logger.js";
const CHAT_REQUEST_TIMEOUT_MS = 30000;
const CHAT_MAX_RETRIES = 0;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const PLUGIN_USER_AGENT = "opencode-qwen-cli-auth/2.2.1";
/**
 * Get valid access token from SDK auth state, refresh if expired.
 * Uses getAuth() from SDK instead of reading file directly.
 *
 * @param getAuth - Function to get auth state from SDK
 * @returns Access token or null
 */
async function getValidAccessToken(getAuth) {
    const diskToken = await getValidToken();
    if (diskToken?.accessToken) {
        return diskToken.accessToken;
    }
    const auth = await getAuth();
    if (!auth || auth.type !== "oauth") {
        return null;
    }
    let accessToken = auth.access;
    // Refresh if expired (60 second buffer)
    if (accessToken && auth.expires && Date.now() > auth.expires - 60000 && auth.refresh) {
        try {
            const refreshResult = await refreshAccessToken(auth.refresh);
            if (refreshResult.type === "success") {
                accessToken = refreshResult.access;
                saveToken(refreshResult);
            }
            else {
                if (LOGGING_ENABLED) {
                    logError("Token refresh failed");
                }
                accessToken = undefined;
            }
        }
        catch (e) {
            if (LOGGING_ENABLED) {
                logError("Token refresh error:", e);
            }
            accessToken = undefined;
        }
    }
    if (auth.access && auth.refresh) {
        try {
            saveToken({
                type: "success",
                access: accessToken || auth.access,
                refresh: auth.refresh,
                expires: typeof auth.expires === "number" ? auth.expires : Date.now() + 3600 * 1000,
            });
        }
        catch (e) {
            logWarn("Failed to bootstrap .qwen token from SDK auth state:", e);
        }
    }
    return accessToken ?? null;
}
/**
 * Get base URL from token stored on disk (resource_url).
 * Falls back to portal.qwen.ai/v1 if not available.
 */
function getBaseUrl() {
    try {
        const stored = loadStoredToken();
        if (stored?.resource_url) {
            return getApiBaseUrl(stored.resource_url);
        }
    }
    catch (e) {
        logWarn("Failed to load stored token for baseURL, using default:", e);
    }
    return getApiBaseUrl();
}
/**
 * Alibaba Qwen OAuth authentication plugin for opencode
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-alibaba-qwen-cli-auth"],
 *   "model": "qwen-code/coder-model"
 * }
 * ```
 */
export const QwenAuthPlugin = async (_input) => {
    return {
        auth: {
            provider: PROVIDER_ID,
            /**
             * Loader: get token + base URL, return to SDK.
             * Pattern similar to opencode-qwencode-auth reference plugin.
             */
            async loader(getAuth, provider) {
                // Zero cost for OAuth models (free)
                if (provider?.models) {
                    for (const model of Object.values(provider.models)) {
                        if (model) model.cost = { input: 0, output: 0 };
                    }
                }
                const accessToken = await getValidAccessToken(getAuth);
                if (!accessToken) return null;
                const baseURL = getBaseUrl();
                if (LOGGING_ENABLED) {
                    logInfo("Using Qwen baseURL:", baseURL);
                }
                return {
                    apiKey: accessToken,
                    baseURL,
                    timeout: CHAT_REQUEST_TIMEOUT_MS,
                    maxRetries: CHAT_MAX_RETRIES,
                };
            },
            methods: [
                {
                    label: AUTH_LABELS.OAUTH,
                    type: "oauth",
                    /**
                     * Device Authorization Grant OAuth flow (RFC 8628)
                     */
                    authorize: async () => {
                        // Generate PKCE
                        const pkce = await createPKCE();
                        // Request device code
                        const deviceAuth = await requestDeviceCode(pkce);
                        if (!deviceAuth) {
                            throw new Error("Failed to request device code");
                        }
                        // Display user code
                        console.log(`\nPlease visit: ${deviceAuth.verification_uri}`);
                        console.log(`And enter code: ${deviceAuth.user_code}\n`);
                        // Verification URL - SDK will open browser automatically when method=auto
                        const verificationUrl = deviceAuth.verification_uri_complete || deviceAuth.verification_uri;
                        return {
                            url: verificationUrl,
                            method: "auto",
                            instructions: AUTH_LABELS.INSTRUCTIONS,
                            callback: async () => {
                                // Poll for token
                                let pollInterval = (deviceAuth.interval || 5) * 1000;
                                const POLLING_MARGIN_MS = 3000;
                                const maxInterval = DEVICE_FLOW.MAX_POLL_INTERVAL;
                                const startTime = Date.now();
                                const expiresIn = deviceAuth.expires_in * 1000;
                                let consecutivePollFailures = 0;
                                while (Date.now() - startTime < expiresIn) {
                                    await new Promise(resolve => setTimeout(resolve, pollInterval + POLLING_MARGIN_MS));
                                    const result = await pollForToken(deviceAuth.device_code, pkce.verifier);
                                    if (result.type === "success") {
                                        saveToken(result);
                                        // Return to SDK to save auth state
                                        return {
                                            type: "success",
                                            access: result.access,
                                            refresh: result.refresh,
                                            expires: result.expires,
                                        };
                                    }
                                    if (result.type === "slow_down") {
                                        consecutivePollFailures = 0;
                                        pollInterval = Math.min(pollInterval + 5000, maxInterval);
                                        continue;
                                    }
                                    if (result.type === "pending") {
                                        consecutivePollFailures = 0;
                                        continue;
                                    }
                                    if (result.type === "failed") {
                                        if (result.fatal) {
                                            logError("OAuth token polling failed with fatal error", {
                                                status: result.status,
                                                error: result.error,
                                                description: result.description,
                                            });
                                            return { type: "failed" };
                                        }
                                        consecutivePollFailures += 1;
                                        logWarn(`OAuth token polling failed (${consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
                                        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                                            console.error("[qwen-oauth-plugin] OAuth token polling failed repeatedly");
                                            return { type: "failed" };
                                        }
                                        continue;
                                    }
                                    if (result.type === "denied") {
                                        console.error("[qwen-oauth-plugin] Device authorization was denied");
                                        return { type: "failed" };
                                    }
                                    if (result.type === "expired") {
                                        console.error("[qwen-oauth-plugin] Device authorization code expired");
                                        return { type: "failed" };
                                    }
                                    return { type: "failed" };
                                }
                                console.error("[qwen-oauth-plugin] Device authorization timed out");
                                return { type: "failed" };
                            },
                        };
                    },
                },
            ],
        },
        /**
         * Register qwen-code provider with model list.
         * Only register models that Portal API (OAuth) accepts:
         * coder-model and vision-model (according to QWEN_OAUTH_ALLOWED_MODELS from original CLI)
         */
        config: async (config) => {
            const providers = config.provider || {};
            providers[PROVIDER_ID] = {
                npm: "@ai-sdk/openai-compatible",
                name: "Qwen Code",
                options: {
                    baseURL: getBaseUrl(),
                    timeout: CHAT_REQUEST_TIMEOUT_MS,
                    maxRetries: CHAT_MAX_RETRIES,
                },
                models: {
                    "coder-model": {
                        id: "coder-model",
                        name: "Qwen Coder (Qwen 3.5 Plus)",
                        // Qwen does not support reasoning_effort from OpenCode UI
                        // Thinking is always enabled by default on server side (qwen3.5-plus)
                        reasoning: false,
                        limit: { context: 1048576, output: 65536 },
                        cost: { input: 0, output: 0 },
                        modalities: { input: ["text"], output: ["text"] },
                    },
                    "vision-model": {
                        id: "vision-model",
                        name: "Qwen VL Plus (vision)",
                        reasoning: false,
                        limit: { context: 131072, output: 8192 },
                        cost: { input: 0, output: 0 },
                        modalities: { input: ["text"], output: ["text"] },
                    },
                },
            };
            config.provider = providers;
        },
        "chat.params": async (input, output) => {
            try {
                output.options = output.options || {};
                output.options.maxRetries = CHAT_MAX_RETRIES;
                if (typeof output.options.timeout !== "number" || output.options.timeout > CHAT_REQUEST_TIMEOUT_MS) {
                    output.options.timeout = CHAT_REQUEST_TIMEOUT_MS;
                }
                if (LOGGING_ENABLED) {
                    logInfo("Applied chat.params hotfix", {
                        sessionID: input?.sessionID,
                        modelID: input?.model?.id,
                        timeout: output.options.timeout,
                        maxRetries: output.options.maxRetries,
                    });
                }
            }
            catch (e) {
                logWarn("Failed to apply chat params hotfix:", e);
            }
        },
        /**
         * Send DashScope headers like original CLI.
         * X-DashScope-CacheControl: enable prompt caching, reduce token consumption.
         * X-DashScope-AuthType: specify auth method for server.
         */
        "chat.headers": async (input, output) => {
            try {
                output.headers = output.headers || {};
                const requestId = randomUUID();
                output.headers["X-DashScope-CacheControl"] = "enable";
                output.headers[PORTAL_HEADERS.AUTH_TYPE] = PORTAL_HEADERS.AUTH_TYPE_VALUE;
                output.headers["User-Agent"] = PLUGIN_USER_AGENT;
                output.headers["X-DashScope-UserAgent"] = PLUGIN_USER_AGENT;
                output.headers["x-request-id"] = requestId;
                if (LOGGING_ENABLED) {
                    logInfo("Applied chat.headers", {
                        request_id: requestId,
                        sessionID: input?.sessionID,
                        modelID: input?.model?.id,
                        providerID: input?.provider?.info?.id,
                    });
                }
            }
            catch (e) {
                logWarn("Failed to set chat headers:", e);
            }
        },
    };
};
export default QwenAuthPlugin;
//# sourceMappingURL=index.js.map
