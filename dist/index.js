/**
 * Alibaba Qwen OAuth Authentication Plugin for opencode
 *
 * Plugin don gian: chi xu ly OAuth login + tra apiKey/baseURL cho SDK.
 * SDK tu xu ly streaming, headers, request format.
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @repository https://github.com/TVD-00/opencode-qwen-cli-auth
 */
import { createPKCE, requestDeviceCode, pollForToken, getApiBaseUrl, saveToken, refreshAccessToken, loadStoredToken } from "./lib/auth/auth.js";
import { PROVIDER_ID, AUTH_LABELS, DEVICE_FLOW, DEFAULT_QWEN_BASE_URL } from "./lib/constants.js";
import { logError, logInfo, LOGGING_ENABLED } from "./lib/logger.js";
/**
 * Lay access token hop le tu SDK auth state, refresh neu het han
 * Dung getAuth() cua SDK thay vi doc file truc tiep
 *
 * @param getAuth - Ham lay auth state tu SDK
 * @returns access token hoac null
 */
async function getValidAccessToken(getAuth) {
    const auth = await getAuth();
    if (!auth || auth.type !== "oauth") {
        return null;
    }
    let accessToken = auth.access;
    // Refresh neu het han (buffer 60 giay)
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
    return accessToken ?? null;
}
/**
 * Lay base URL tu token luu tren disk (resource_url)
 * Fallback ve portal.qwen.ai/v1 neu khong co
 */
function getBaseUrl() {
    try {
        const stored = loadStoredToken();
        if (stored?.resource_url) {
            return getApiBaseUrl(stored.resource_url);
        }
    }
    catch (_) {
        // Loi doc file, dung default
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
             * Loader: lay token + base URL, tra ve cho SDK
             * Pattern giong plugin tham chieu opencode-qwencode-auth
             */
            async loader(getAuth, provider) {
                // Zero cost cho OAuth models (mien phi)
                if (provider?.models) {
                    for (const model of Object.values(provider.models)) {
                        if (model) model.cost = { input: 0, output: 0 };
                    }
                }
                const accessToken = await getValidAccessToken(getAuth);
                if (!accessToken) return null;
                return {
                    apiKey: accessToken,
                    baseURL: DEFAULT_QWEN_BASE_URL,
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
                        // Hien thi user code
                        console.log(`\nPlease visit: ${deviceAuth.verification_uri}`);
                        console.log(`And enter code: ${deviceAuth.user_code}\n`);
                        // URL xac thuc - SDK se tu mo browser khi method=auto
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
                                while (Date.now() - startTime < expiresIn) {
                                    await new Promise(resolve => setTimeout(resolve, pollInterval + POLLING_MARGIN_MS));
                                    const result = await pollForToken(deviceAuth.device_code, pkce.verifier);
                                    if (result.type === "success") {
                                        saveToken(result);
                                        // Tra ve cho SDK luu auth state
                                        return {
                                            type: "success",
                                            access: result.access,
                                            refresh: result.refresh,
                                            expires: result.expires,
                                        };
                                    }
                                    if (result.type === "slow_down") {
                                        pollInterval = Math.min(pollInterval + 5000, maxInterval);
                                        continue;
                                    }
                                    if (result.type === "pending") {
                                        continue;
                                    }
                                    // denied, expired, failed -> dung lai
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
         * Dang ky provider qwen-code voi danh sach model
         * Chi dang ky model ma Portal API (OAuth) chap nhan:
         * coder-model va vision-model (theo QWEN_OAUTH_ALLOWED_MODELS cua CLI goc)
         */
        config: async (config) => {
            const providers = config.provider || {};
            providers[PROVIDER_ID] = {
                npm: "@ai-sdk/openai-compatible",
                name: "Qwen Code",
                options: { baseURL: "https://portal.qwen.ai/v1" },
                models: {
                    "coder-model": {
                        id: "coder-model",
                        name: "Qwen Coder (Qwen 3.5 Plus)",
                        reasoning: true,
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
        /**
         * Gui header DashScope giong CLI goc
         * X-DashScope-CacheControl: enable prompt caching, giam token tieu thu
         * X-DashScope-AuthType: xac dinh auth method cho server
         */
        "chat.headers": async (_input, output) => {
            try {
                if (output?.headers) {
                    output.headers["X-DashScope-CacheControl"] = "enable";
                    output.headers["X-DashScope-AuthType"] = "qwen-oauth";
                }
            }
            catch (_) { /* khong de loi hook lam treo request */ }
        },
    };
};
export default QwenAuthPlugin;
//# sourceMappingURL=index.js.map