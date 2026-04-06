/**
 * Qwen OAuth authentication plugin for OpenCode
 *
 * Architecture follows OpenCode's Copilot/Codex plugin pattern:
 * - auth.loader returns { fetch, apiKey, baseURL, timeout }
 * - Custom fetch handles DashScope headers and token refresh
 * - OpenCode handles timeout, retries, and streaming natively
 *
 * @version 3.0.0
 */
import { createPKCE, requestDeviceCode, pollForToken, getApiBaseUrl, saveToken, refreshAccessToken, loadStoredToken, getValidToken, upsertOAuthAccount, getActiveOAuthAccount, markOAuthAccountQuotaExhausted, switchToNextHealthyOAuthAccount, } from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { PROVIDER_ID, AUTH_LABELS, DEVICE_FLOW, PORTAL_HEADERS, TOKEN_REFRESH_BUFFER_MS, } from "./lib/constants.js";
import { logInfo, logWarn, LOGGING_ENABLED } from "./lib/logger.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QWEN_CLI_VERSION = "0.13.1";
const PLUGIN_USER_AGENT = `QwenCode/${QWEN_CLI_VERSION} (${process.platform}; ${process.arch})`;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const CHAT_MAX_TOKENS_CAP = 65536;
/** In-memory token cache to reduce Disk I/O per request (Issue 3.0) */
const TOKEN_CACHE_TTL_MS = 10_000; // 10 seconds
let cachedAccountResponse = null;
let cachedAccountResponseExpiry = 0;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getBaseUrl(resourceUrl) {
    if (typeof resourceUrl === "string" && resourceUrl.length > 0) {
        return getApiBaseUrl(resourceUrl);
    }
    try {
        const stored = loadStoredToken();
        if (stored?.resource_url)
            return getApiBaseUrl(stored.resource_url);
    }
    catch {
        // ignore — use default
    }
    return getApiBaseUrl();
}
/**
 * Resolve a valid access token from multi-account store, disk, or SDK state.
 */
async function getValidAccessToken(getAuth) {
    // 1) Multi-account store
    const active = await getActiveOAuthAccount({ allowExhausted: false });
    if (active?.accessToken) {
        return {
            accessToken: active.accessToken,
            resourceUrl: active.resourceUrl,
            accountId: active.accountId,
        };
    }
    // 2) Disk token (~/.qwen/oauth_creds.json)
    const disk = await getValidToken();
    if (disk?.accessToken) {
        return { accessToken: disk.accessToken, resourceUrl: disk.resourceUrl };
    }
    // 3) SDK auth state
    const auth = await getAuth();
    if (!auth || auth.type !== "oauth")
        return null;
    let accessToken = auth.access;
    let resourceUrl;
    if (accessToken &&
        auth.expires &&
        Date.now() > auth.expires - TOKEN_REFRESH_BUFFER_MS &&
        auth.refresh) {
        try {
            const r = await refreshAccessToken(auth.refresh);
            if (r.type === "success") {
                accessToken = r.access;
                resourceUrl = r.resourceUrl;
                saveToken(r);
                await upsertOAuthAccount(r, { setActive: false });
                // Fix 1.1: Return early to prevent bootstrap block from overwriting
                // the freshly refreshed token with stale SDK auth state
                return { accessToken, resourceUrl };
            }
            else {
                accessToken = undefined;
            }
        }
        catch {
            accessToken = undefined;
        }
    }
    // Bootstrap to disk for future use
    if (auth.access && auth.refresh) {
        try {
            const t = {
                type: "success",
                access: accessToken || auth.access,
                refresh: auth.refresh,
                expires: typeof auth.expires === "number"
                    ? auth.expires
                    : Date.now() + 3600_000,
                resourceUrl,
            };
            saveToken(t);
            await upsertOAuthAccount(t, { setActive: false });
        }
        catch {
            // non-fatal
        }
    }
    return accessToken ? { accessToken, resourceUrl } : null;
}
/**
 * Set required DashScope headers on a Headers object.
 * Matches qwen-code DashScopeOpenAICompatibleProvider.buildHeaders().
 */
function applyDashScopeHeaders(h) {
    if (!h.has("X-DashScope-AuthType"))
        h.set("X-DashScope-AuthType", PORTAL_HEADERS.AUTH_TYPE_VALUE);
    if (!h.has("X-DashScope-CacheControl"))
        h.set("X-DashScope-CacheControl", "enable");
    if (!h.has("User-Agent"))
        h.set("User-Agent", PLUGIN_USER_AGENT);
    if (!h.has("X-DashScope-UserAgent"))
        h.set("X-DashScope-UserAgent", PLUGIN_USER_AGENT);
}
async function pollDeviceFlow(deviceAuth, verifier, onSuccess) {
    let interval = (deviceAuth.interval || 5) * 1000;
    const margin = 3000;
    const maxInterval = DEVICE_FLOW.MAX_POLL_INTERVAL;
    const deadline = Date.now() + deviceAuth.expires_in * 1000;
    let failures = 0;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval + margin));
        const r = await pollForToken(deviceAuth.device_code, verifier);
        if (r.type === "success") {
            await onSuccess(r);
            return {
                type: "success",
                access: r.access,
                refresh: r.refresh,
                expires: r.expires,
            };
        }
        if (r.type === "slow_down") {
            failures = 0;
            interval = Math.min(interval + 5000, maxInterval);
            continue;
        }
        if (r.type === "pending") {
            failures = 0;
            continue;
        }
        if (r.type === "failed" && !r.fatal) {
            failures += 1;
            if (failures >= MAX_CONSECUTIVE_POLL_FAILURES)
                break;
            continue;
        }
        break; // denied, expired, fatal, or unknown
    }
    return { type: "failed" };
}
// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export const QwenAuthPlugin = async () => ({
    // ---- auth ----------------------------------------------------------------
    auth: {
        provider: PROVIDER_ID,
        /**
         * Called by OpenCode during provider initialization (provider.ts ~line 937).
         * Returns options merged into the AI-SDK provider constructor.
         *
         * Pattern identical to Copilot / Codex plugins:
         *   - apiKey for SDK constructor validation
         *   - custom fetch for auth + headers
         *   - timeout: false so OpenCode's own timeout wrapper is the only guard
         *
         * OpenCode wraps our fetch with its own timeout logic in getSDK():
         *   options["fetch"] = (input, init) => {
         *     if (options["timeout"] !== false) signals.push(AbortSignal.timeout(...))
         *     return customFetch(input, { ...init, timeout: false })
         *   }
         *
         * By returning timeout: false, we ensure NO AbortSignal.timeout is added.
         * OpenCode's streamText() passes abortSignal from the session — that's
         * the only cancellation mechanism, which is correct.
         */
        async loader(getAuth, provider) {
            // Zero cost for free OAuth models
            if (provider?.models) {
                for (const m of Object.values(provider.models)) {
                    if (m)
                        m.cost = {
                            input: 0,
                            output: 0,
                        };
                }
            }
            const token = await getValidAccessToken(getAuth);
            if (!token?.accessToken)
                return {};
            const baseURL = getBaseUrl(token.resourceUrl);
            if (LOGGING_ENABLED)
                logInfo("loader baseURL:", baseURL);
            return {
                apiKey: token.accessToken,
                baseURL,
                timeout: false,
                /**
                 * Custom fetch — innermost layer in OpenCode's fetch chain.
                 *
                 * Call chain:
                 *   AI SDK → streamText headers → OpenCode getSDK() wrapper → THIS → global fetch
                 *
                 * We handle:
                 *   1. DashScope-specific headers (like qwen-code CLI)
                 *   2. Fresh Authorization header (token may expire between turns)
                 *   3. 401 → token refresh + single retry
                 *   4. 429 insufficient_quota → account switch + single retry
                 *
                 * We do NOT handle:
                 *   - Timeout (OpenCode's getSDK wrapper handles via AbortSignal)
                 *   - Retries (AI SDK maxRetries handles, OpenCode sets maxRetries: 0)
                 *   - Streaming (OpenCode/AI SDK handle natively)
                 *   - Payload sanitization (not needed — AI SDK builds clean payloads)
                 */
                async fetch(input, init) {
                    const opts = init ? { ...init } : {};
                    // -- Headers --
                    const headers = new Headers(opts.headers);
                    applyDashScopeHeaders(headers);
                    // Fix 3.0: Use in-memory cache to avoid disk I/O on every request
                    let fresh;
                    if (cachedAccountResponse && Date.now() < cachedAccountResponseExpiry) {
                        fresh = cachedAccountResponse;
                    }
                    else {
                        fresh = await getActiveOAuthAccount({
                            allowExhausted: false,
                        });
                        cachedAccountResponse = fresh;
                        cachedAccountResponseExpiry = Date.now() + TOKEN_CACHE_TTL_MS;
                    }
                    // Fix 1.2: Track the current account ID dynamically for 429 handling
                    const currentAccountId = fresh?.accountId || null;
                    if (fresh?.accessToken) {
                        headers.set("Authorization", `Bearer ${fresh.accessToken}`);
                    }
                    opts.headers = headers;
                    // -- Request --
                    let response = await globalThis.fetch(input, opts);
                    // -- 401: token expired mid-session --
                    if (response.status === 401) {
                        const body = await response.text().catch(() => ""); // consume body
                        if (LOGGING_ENABLED)
                            logWarn("401 — refreshing token");
                        try {
                            // Fix 2.2: Mark current account as auth_invalid BEFORE fetching
                            // a new one. Otherwise getActiveOAuthAccount may return the same
                            // token because isTokenExpired() checks local time, not server state.
                            if (currentAccountId) {
                                await markOAuthAccountQuotaExhausted(currentAccountId, "auth_invalid");
                            }
                            // Invalidate cache so we get a genuinely different account
                            cachedAccountResponse = null;
                            cachedAccountResponseExpiry = 0;
                            const refreshed = await getActiveOAuthAccount({
                                allowExhausted: false,
                            });
                            if (refreshed?.accessToken) {
                                // Update cache with the new account
                                cachedAccountResponse = refreshed;
                                cachedAccountResponseExpiry = Date.now() + TOKEN_CACHE_TTL_MS;
                                headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
                                opts.headers = headers;
                                response = await globalThis.fetch(input, opts);
                            }
                            else {
                                // Fix 1.3: Reconstruct response with consumed body
                                response = new Response(body, {
                                    status: 401,
                                    statusText: response.statusText,
                                    headers: response.headers,
                                });
                            }
                        }
                        catch {
                            // Fix 1.3: Reconstruct original 401 since body was consumed
                            response = new Response(body, {
                                status: 401,
                                statusText: response.statusText,
                                headers: response.headers,
                            });
                        }
                    }
                    // -- 429 insufficient_quota: switch account --
                    // Fix 1.2: Use currentAccountId (dynamic) instead of capturedAccountId (static)
                    if (response.status === 429 && currentAccountId) {
                        const body = await response.text().catch(() => "");
                        if (body.includes("insufficient_quota")) {
                            try {
                                await markOAuthAccountQuotaExhausted(currentAccountId, "insufficient_quota");
                                // Invalidate cache after marking account exhausted
                                cachedAccountResponse = null;
                                cachedAccountResponseExpiry = 0;
                                const next = await switchToNextHealthyOAuthAccount([
                                    currentAccountId,
                                ]);
                                if (next?.accessToken) {
                                    // Update cache with the new account
                                    cachedAccountResponse = next;
                                    cachedAccountResponseExpiry = Date.now() + TOKEN_CACHE_TTL_MS;
                                    headers.set("Authorization", `Bearer ${next.accessToken}`);
                                    opts.headers = headers;
                                    if (LOGGING_ENABLED)
                                        logInfo("Switched account after quota", {
                                            to: next.accountId,
                                        });
                                    response = await globalThis.fetch(input, opts);
                                }
                                else {
                                    // No healthy account — reconstruct 429 with original body
                                    response = new Response(body, {
                                        status: 429,
                                        statusText: "Too Many Requests",
                                        headers: response.headers,
                                    });
                                }
                            }
                            catch {
                                response = new Response(body, {
                                    status: 429,
                                    statusText: "Too Many Requests",
                                    headers: response.headers,
                                });
                            }
                        }
                        else {
                            // Non-quota 429 — reconstruct response with consumed body
                            response = new Response(body, {
                                status: 429,
                                statusText: response.statusText,
                                headers: response.headers,
                            });
                        }
                    }
                    return response;
                },
            };
        },
        methods: [
            // -- Primary login --
            {
                label: AUTH_LABELS.OAUTH,
                type: "oauth",
                authorize: async () => {
                    const pkce = await createPKCE();
                    const dev = await requestDeviceCode(pkce);
                    if (!dev)
                        throw new Error("Failed to request device code");
                    console.log(`\nPlease visit: ${dev.verification_uri}`);
                    console.log(`And enter code: ${dev.user_code}\n`);
                    const url = dev.verification_uri_complete || dev.verification_uri;
                    openBrowserUrl(url);
                    return {
                        url,
                        method: "auto",
                        instructions: AUTH_LABELS.INSTRUCTIONS,
                        callback: () => pollDeviceFlow(dev, pkce.verifier, async (r) => {
                            saveToken(r);
                            await upsertOAuthAccount(r, { setActive: true });
                        }).then((r) => r.type === "success"
                            ? {
                                type: "success",
                                access: r.access,
                                refresh: r.refresh,
                                expires: r.expires,
                            }
                            : { type: "failed" }),
                    };
                },
            },
            // -- Add another account --
            {
                label: "Add another Qwen account (multi-account switch)",
                type: "oauth",
                authorize: async () => {
                    const pkce = await createPKCE();
                    const dev = await requestDeviceCode(pkce);
                    if (!dev)
                        throw new Error("Failed to request device code");
                    console.log(`\n[Add Account] Please visit: ${dev.verification_uri}`);
                    console.log(`[Add Account] Enter code: ${dev.user_code}\n`);
                    const url = dev.verification_uri_complete || dev.verification_uri;
                    openBrowserUrl(url);
                    return {
                        url,
                        method: "auto",
                        instructions: "Login with a DIFFERENT Qwen account to add it as backup.",
                        callback: () => pollDeviceFlow(dev, pkce.verifier, async (r) => {
                            await upsertOAuthAccount(r, {
                                setActive: false,
                                forceNew: true,
                            });
                            // Restore active account token file
                            await getActiveOAuthAccount({ allowExhausted: true }).catch(() => null);
                        }).then((r) => r.type === "success"
                            ? {
                                type: "success",
                                access: r.access,
                                refresh: r.refresh,
                                expires: r.expires,
                            }
                            : { type: "failed" }),
                    };
                },
            },
        ],
    },
    // ---- config --------------------------------------------------------------
    config: async (config) => {
        const providers = config.provider ||
            {};
        providers[PROVIDER_ID] = {
            npm: "@ai-sdk/openai-compatible",
            name: "Qwen Code",
            options: { baseURL: getBaseUrl(), timeout: false },
            models: {
                "coder-model": {
                    id: "coder-model",
                    name: "Qwen 3.6 Plus",
                    attachment: false,
                    reasoning: true,
                    limit: { context: 1_048_576, output: CHAT_MAX_TOKENS_CAP },
                    cost: { input: 0, output: 0 },
                    modalities: { input: ["text"], output: ["text"] },
                    variants: {
                        low: { disabled: true },
                        medium: { disabled: true },
                        high: { disabled: true },
                    },
                },
                "vision-model": {
                    id: "vision-model",
                    name: "Qwen Vision",
                    attachment: true,
                    reasoning: false,
                    limit: { context: 131_072, output: 8192 },
                    cost: { input: 0, output: 0 },
                    modalities: { input: ["text", "image"], output: ["text"] },
                },
            },
        };
        config.provider =
            providers;
    },
    // ---- chat.params ---------------------------------------------------------
    "chat.params": async (_input, output) => {
        try {
            const out = output;
            out.options = out.options || {};
            const cap = CHAT_MAX_TOKENS_CAP;
            for (const key of [
                "max_tokens",
                "max_completion_tokens",
                "maxTokens",
            ]) {
                if (typeof out[key] === "number" && out[key] > cap)
                    out[key] = cap;
                if (typeof out.options[key] === "number" &&
                    out.options[key] > cap)
                    out.options[key] = cap;
            }
        }
        catch (e) {
            logWarn("chat.params error:", e);
        }
    },
    // ---- chat.headers --------------------------------------------------------
    "chat.headers": async (_input, output) => {
        try {
            const out = output;
            out.headers = out.headers || {};
            out.headers["X-DashScope-CacheControl"] = "enable";
            out.headers[PORTAL_HEADERS.AUTH_TYPE] = PORTAL_HEADERS.AUTH_TYPE_VALUE;
            out.headers["User-Agent"] = PLUGIN_USER_AGENT;
            out.headers["X-DashScope-UserAgent"] = PLUGIN_USER_AGENT;
        }
        catch (e) {
            logWarn("chat.headers error:", e);
        }
    },
});
export default QwenAuthPlugin;
//# sourceMappingURL=index.js.map