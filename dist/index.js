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
import { PROVIDER_ID, AUTH_LABELS, DEVICE_FLOW } from "./lib/constants.js";
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
 *   "model": "alibaba/coder-model"
 * }
 * ```
 */
export const QwenAuthPlugin = async (_input) => {
    return {
        auth: {
            provider: PROVIDER_ID,
            /**
             * Loader: lay token + base URL, tra ve cho SDK
             * Khong can custom fetch - SDK tu xu ly streaming va headers
             */
            async loader(getAuth, provider) {
                const auth = await getAuth();
                // Chi xu ly OAuth, bo qua API key auth
                if (auth.type !== "oauth") {
                    return {};
                }
                const accessToken = await getValidAccessToken(getAuth);
                if (!accessToken) {
                    return null;
                }
                const baseUrl = getBaseUrl();
                // Tra ve apiKey + baseURL, SDK tu xu ly phan con lai
                return {
                    apiKey: accessToken,
                    baseURL: baseUrl,
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
    };
};
export default QwenAuthPlugin;
//# sourceMappingURL=index.js.map