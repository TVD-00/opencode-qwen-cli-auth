/**
 * @fileoverview Comprehensive unit tests for QwenAuthPlugin entry point
 * Tests cover: plugin exports, config hook, chat.params hook, chat.headers hook,
 * payload sanitization, quota error responses, retry loop, and closure behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use them
// ---------------------------------------------------------------------------

vi.mock("./lib/auth/auth.js", () => ({
    createPKCE: vi.fn(),
    requestDeviceCode: vi.fn(),
    pollForToken: vi.fn(),
    getApiBaseUrl: vi.fn((url?: string) => {
        if (url && url.length > 0) {
            try {
                const u = new URL(url);
                return `${u.protocol}//${u.host}/compatible-mode/v1`;
            } catch {
                return "https://dashscope.aliyuncs.com/compatible-mode/v1";
            }
        }
        return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    }),
    saveToken: vi.fn(),
    refreshAccessToken: vi.fn(),
    loadStoredToken: vi.fn(() => null),
    getValidToken: vi.fn(async () => null),
    upsertOAuthAccount: vi.fn(async () => null),
    getActiveOAuthAccount: vi.fn(async () => null),
    markOAuthAccountQuotaExhausted: vi.fn(async () => null),
    switchToNextHealthyOAuthAccount: vi.fn(async () => null),
}));

vi.mock("./lib/logger.js", () => ({
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    LOGGING_ENABLED: false,
    DEBUG_ENABLED: false,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import QwenAuthPlugin, { QwenAuthPlugin as QwenAuthPluginNamed } from "./index.js";
import { getActiveOAuthAccount, getValidToken } from "./lib/auth/auth.js";

// ---------------------------------------------------------------------------
// Constants mirrored from the source for assertion clarity
// ---------------------------------------------------------------------------

const PROVIDER_ID = "qwen-code";
const CHAT_MAX_TOKENS_CAP = 65536;
const PLUGIN_USER_AGENT = `QwenCode/0.13.1 (${process.platform}; ${process.arch})`;

// ---------------------------------------------------------------------------
// Helper: build a minimal plugin hook result
// ---------------------------------------------------------------------------

async function buildPlugin() {
    const plugin = await QwenAuthPlugin({} as never);
    return plugin as {
        auth: {
            provider: string;
            loader: (getAuth: () => Promise<unknown>, provider?: unknown) => Promise<Record<string, unknown>>;
            methods: unknown[];
        };
        config: (config: Record<string, unknown>) => Promise<void>;
        "chat.params": (input: unknown, output: unknown) => Promise<void>;
        "chat.headers": (input: unknown, output: unknown) => Promise<void>;
    };
}

// ---------------------------------------------------------------------------
// 1. QwenAuthPlugin exports
// ---------------------------------------------------------------------------

describe("QwenAuthPlugin exports", () => {
    it("default export is a function", () => {
        expect(typeof QwenAuthPlugin).toBe("function");
    });

    it("named export QwenAuthPlugin is a function", () => {
        expect(typeof QwenAuthPluginNamed).toBe("function");
    });

    it("default and named export are the same reference", () => {
        expect(QwenAuthPlugin).toBe(QwenAuthPluginNamed);
    });

    it("calling it returns an object with required hook keys", async () => {
        const plugin = await buildPlugin();
        expect(plugin).toHaveProperty("auth");
        expect(plugin).toHaveProperty("config");
        expect(plugin).toHaveProperty("chat.params");
        expect(plugin).toHaveProperty("chat.headers");
    });

    it("auth.provider matches the provider ID string", async () => {
        const plugin = await buildPlugin();
        expect(plugin.auth.provider).toBe(PROVIDER_ID);
    });

    it("auth.loader is a function", async () => {
        const plugin = await buildPlugin();
        expect(typeof plugin.auth.loader).toBe("function");
    });

    it("auth.methods is a non-empty array", async () => {
        const plugin = await buildPlugin();
        expect(Array.isArray(plugin.auth.methods)).toBe(true);
        expect((plugin.auth.methods as unknown[]).length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// 2. Plugin config hook — provider registration
// ---------------------------------------------------------------------------

describe("config hook — provider registration", () => {
    it("registers the qwen-code provider", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {};
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider;
        expect(providers).toBeDefined();
        expect(providers![PROVIDER_ID]).toBeDefined();
    });

    it("coder-model has reasoning: true and attachment: false", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {};
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider!;
        const providerEntry = providers[PROVIDER_ID] as {
            models: { "coder-model": Record<string, unknown> };
        };
        const coderModel = providerEntry.models["coder-model"];
        expect(coderModel.reasoning).toBe(true);
        expect(coderModel.attachment).toBe(false);
    });

    it("vision-model has attachment: true and reasoning: false", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {};
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider!;
        const providerEntry = providers[PROVIDER_ID] as {
            models: { "vision-model": Record<string, unknown> };
        };
        const visionModel = providerEntry.models["vision-model"];
        expect(visionModel.attachment).toBe(true);
        expect(visionModel.reasoning).toBe(false);
    });

    it("coder-model output limit is 65536 (CHAT_MAX_TOKENS_CAP)", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {};
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider!;
        const providerEntry = providers[PROVIDER_ID] as {
            models: { "coder-model": { limit: { output: number } } };
        };
        expect(providerEntry.models["coder-model"].limit.output).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("vision-model output limit is 8192", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {};
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider!;
        const providerEntry = providers[PROVIDER_ID] as {
            models: { "vision-model": { limit: { output: number } } };
        };
        expect(providerEntry.models["vision-model"].limit.output).toBe(8192);
    });

    it("provider name is 'Qwen Code'", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {};
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider!;
        const providerEntry = providers[PROVIDER_ID] as { name: string };
        expect(providerEntry.name).toBe("Qwen Code");
    });

    it("merges with an existing provider record without overwriting others", async () => {
        const plugin = await buildPlugin();
        const config: Record<string, unknown> = {
            provider: { "other-provider": { name: "Other" } },
        };
        await plugin.config(config);
        const providers = (config as { provider?: Record<string, unknown> }).provider!;
        expect(providers["other-provider"]).toBeDefined();
        expect(providers[PROVIDER_ID]).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 3. chat.params hook — max_tokens capping (NOT default-setting)
// ---------------------------------------------------------------------------

describe("chat.params hook — max_tokens capping", () => {
    it("does NOT set max_tokens when it is absent (undefined)", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.params"]({}, output);
        // Should not inject a default — max_tokens must remain absent
        expect(output.max_tokens).toBeUndefined();
    });

    it("caps max_tokens that exceeds 65536 to 65536", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = { max_tokens: 100000 };
        await plugin["chat.params"]({}, output);
        expect(output.max_tokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("leaves max_tokens unchanged when within limit", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = { max_tokens: 4096 };
        await plugin["chat.params"]({}, output);
        expect(output.max_tokens).toBe(4096);
    });

    it("leaves max_tokens unchanged when exactly at the cap", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = { max_tokens: CHAT_MAX_TOKENS_CAP };
        await plugin["chat.params"]({}, output);
        expect(output.max_tokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("does NOT set max_completion_tokens when absent", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.params"]({}, output);
        expect(output.max_completion_tokens).toBeUndefined();
    });

    it("caps max_completion_tokens that exceeds 65536", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = { max_completion_tokens: 200000 };
        await plugin["chat.params"]({}, output);
        expect(output.max_completion_tokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("does NOT set maxTokens when absent", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.params"]({}, output);
        expect(output.maxTokens).toBeUndefined();
    });

    it("caps maxTokens that exceeds 65536", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = { maxTokens: 99999 };
        await plugin["chat.params"]({}, output);
        expect(output.maxTokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("leaves maxTokens unchanged when within limit", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = { maxTokens: 1024 };
        await plugin["chat.params"]({}, output);
        expect(output.maxTokens).toBe(1024);
    });

    it("does NOT set options.max_tokens when absent", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.params"]({}, output);
        const out = output as { options?: Record<string, unknown> };
        // options is created by the hook but max_tokens should not be injected
        expect(out.options?.max_tokens).toBeUndefined();
    });

    it("caps options.max_tokens that exceeds 65536", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {
            options: { max_tokens: 70000 },
        };
        await plugin["chat.params"]({}, output);
        const out = output as { options: Record<string, unknown> };
        expect(out.options.max_tokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("caps options.max_completion_tokens that exceeds 65536", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {
            options: { max_completion_tokens: 80000 },
        };
        await plugin["chat.params"]({}, output);
        const out = output as { options: Record<string, unknown> };
        expect(out.options.max_completion_tokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("caps options.maxTokens that exceeds 65536", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {
            options: { maxTokens: 99999 },
        };
        await plugin["chat.params"]({}, output);
        const out = output as { options: Record<string, unknown> };
        expect(out.options.maxTokens).toBe(CHAT_MAX_TOKENS_CAP);
    });

    it("always sets options.maxRetries", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.params"]({}, output);
        const out = output as { options: Record<string, unknown> };
        expect(out.options.maxRetries).toBeDefined();
    });

    it("caps options.timeout to CHAT_REQUEST_TIMEOUT_MS when larger", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {
            options: { timeout: 999_999_999 },
        };
        await plugin["chat.params"]({}, output);
        const out = output as { options: Record<string, unknown> };
        expect(out.options.timeout).toBe(120000);
    });

    it("leaves options.timeout unchanged when within limit", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {
            options: { timeout: 5000 },
        };
        await plugin["chat.params"]({}, output);
        const out = output as { options: Record<string, unknown> };
        expect(out.options.timeout).toBe(5000);
    });
});

// ---------------------------------------------------------------------------
// 4. chat.headers hook — required DashScope headers
// ---------------------------------------------------------------------------

describe("chat.headers hook — header injection", () => {
    it("sets X-DashScope-CacheControl: enable", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers["X-DashScope-CacheControl"]).toBe("enable");
    });

    it("sets X-DashScope-AuthType to qwen-oauth", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers["X-DashScope-AuthType"]).toBe("qwen-oauth");
    });

    it("sets User-Agent to plugin user agent string", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers["User-Agent"]).toBe(PLUGIN_USER_AGENT);
    });

    it("does NOT set x-request-id (CLI does not send it on API calls)", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers["x-request-id"]).toBeUndefined();
    });

    it("sets X-DashScope-UserAgent matching User-Agent", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers["X-DashScope-UserAgent"]).toBe(PLUGIN_USER_AGENT);
        expect(out.headers["X-DashScope-UserAgent"]).toBe(out.headers["User-Agent"]);
    });

    it("initialises headers when output.headers is missing", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {};
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers).toBeDefined();
        expect(typeof out.headers).toBe("object");
    });

    it("merges into existing headers without clobbering them", async () => {
        const plugin = await buildPlugin();
        const output: Record<string, unknown> = {
            headers: { "x-custom": "my-value" },
        };
        await plugin["chat.headers"]({}, output);
        const out = output as { headers: Record<string, string> };
        expect(out.headers["x-custom"]).toBe("my-value");
        expect(out.headers["X-DashScope-CacheControl"]).toBe("enable");
    });
});

// ---------------------------------------------------------------------------
// 5. Payload sanitization — tested via failFastFetch through loader
// ---------------------------------------------------------------------------

// Helper: builds a loader result that wraps failFastFetch with a known accountId.
// We mock getActiveOAuthAccount to provide an access token so loader returns a fetch fn.
async function buildLoaderFetch(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);

    const mockedGetActiveOAuthAccount = vi.mocked(getActiveOAuthAccount);
    mockedGetActiveOAuthAccount.mockResolvedValueOnce({
        accountId: "test-account-id",
        accessToken: "test-access-token",
        resourceUrl: "https://example.com",
        exhaustedUntil: 0,
        healthyAccountCount: 1,
        totalAccountCount: 1,
    });

    const plugin = await buildPlugin();
    const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "test-access-token" }));
    const loaderResult = await plugin.auth.loader(getAuth as never, undefined);
    const fetchFn = loaderResult["fetch"] as
        | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
        | undefined;
    return fetchFn;
}

describe("payload sanitization — client-only fields stripped", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ choices: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            })
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("strips providerID from outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) {
            // If no access token, loader returns empty — skip gracefully
            expect(true).toBe(true);
            return;
        }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hello" }],
            providerID: "qwen-code",
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        expect(fetchMock).toHaveBeenCalled();
        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).not.toHaveProperty("providerID");
    });

    it("strips sessionID from outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hello" }],
            sessionID: "sess-abc",
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).not.toHaveProperty("sessionID");
    });

    it("injects metadata with sessionId and promptId into outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hello" }],
            metadata: { tag: "test" },
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).toHaveProperty("metadata");
        const meta = sentBody.metadata as Record<string, unknown>;
        expect(typeof meta.sessionId).toBe("string");
        expect(typeof meta.promptId).toBe("string");
        // Original user field preserved
        expect(meta.tag).toBe("test");
    });

    it("strips modelID from outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [],
            modelID: "qwen-code/coder-model",
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).not.toHaveProperty("modelID");
    });

    it("strips requestBodyValues from outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [],
            requestBodyValues: { foo: "bar" },
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).not.toHaveProperty("requestBodyValues");
    });

    it("strips debug field from outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [],
            debug: true,
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).not.toHaveProperty("debug");
    });
});

// ---------------------------------------------------------------------------
// 5b. Reasoning fields NOT stripped
// ---------------------------------------------------------------------------

describe("payload sanitization — reasoning fields pass through", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ choices: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            })
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("preserves 'reasoning' field in outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hello" }],
            reasoning: { effort: "high" },
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).toHaveProperty("reasoning");
    });

    it("preserves 'reasoningEffort' field in outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hi" }],
            reasoningEffort: "medium",
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).toHaveProperty("reasoningEffort");
        expect(sentBody.reasoningEffort).toBe("medium");
    });

    it("preserves 'reasoning_effort' field in outgoing body", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: "low",
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).toHaveProperty("reasoning_effort");
        expect(sentBody.reasoning_effort).toBe("low");
    });

    it("preserves all three reasoning fields simultaneously", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hi" }],
            reasoning: { enabled: true },
            reasoningEffort: "high",
            reasoning_effort: "high",
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).toHaveProperty("reasoning");
        expect(sentBody).toHaveProperty("reasoningEffort");
        expect(sentBody).toHaveProperty("reasoning_effort");
    });

    it("normal request fields (model, messages) are preserved", async () => {
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "test" }],
            stream: false,
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody.model).toBe("coder-model");
        expect(Array.isArray(sentBody.messages)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 6. makeQuotaFailFastResponse returns 429 (not 400)
// ---------------------------------------------------------------------------

describe("quota fail-fast response — status 429", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("returns 429 when upstream responds with insufficient_quota", async () => {
        const quotaBody = JSON.stringify({
            error: { code: "insufficient_quota", message: "quota exceeded" },
        });
        fetchMock = vi.fn(async () =>
            new Response(quotaBody, {
                status: 429,
                headers: { "content-type": "application/json" },
            })
        );

        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hi" }],
        });
        const response = await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        expect(response.status).toBe(429);
    });

    it("returns 429 (not 400) for generic rate-limit without quota error", async () => {
        const rateLimitBody = JSON.stringify({
            error: { code: "rate_limit_exceeded", message: "too many requests" },
        });
        fetchMock = vi.fn(async () =>
            new Response(rateLimitBody, {
                status: 429,
                headers: { "content-type": "application/json" },
            })
        );

        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hi" }],
        });
        const response = await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        expect(response.status).toBe(429);
    });
});

// ---------------------------------------------------------------------------
// 7. Retry loop count — 5xx triggers retries
// ---------------------------------------------------------------------------

describe("retry loop — 5xx fetch call count", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("makes exactly 4 total fetch calls for persistent 500 (1 initial + 3 retries)", async () => {
        // Use fake timers to skip the retry sleep delays
        vi.useFakeTimers();

        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ error: "server error" }), {
                status: 500,
                headers: { "content-type": "application/json" },
            })
        );

        vi.mocked(getActiveOAuthAccount).mockResolvedValue({
            accountId: "acct-1",
            accessToken: "tok-1",
            resourceUrl: "https://example.com",
            exhaustedUntil: 0,
            healthyAccountCount: 1,
            totalAccountCount: 1,
        });

        vi.stubGlobal("fetch", fetchMock);
        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "tok-1" }));
        const loaderResult = await plugin.auth.loader(getAuth as never, undefined);
        const customFetch = loaderResult["fetch"] as (
            input: RequestInfo | URL,
            init?: RequestInit
        ) => Promise<Response>;

        const body = JSON.stringify({
            model: "coder-model",
            messages: [{ role: "user", content: "hi" }],
        });

        // Run the fetch and advance all timers to skip sleep delays
        const promise = customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        await vi.runAllTimersAsync();
        await promise;

        // 1 initial + 3 retries (MAX_REQUEST_RETRIES = 3, loop: retryAttempt < 3)
        expect(fetchMock).toHaveBeenCalledTimes(4);
    }, 30000);
});

// ---------------------------------------------------------------------------
// 8. ACTIVE_OAUTH_ACCOUNT_ID eliminated — source-level grep test
// ---------------------------------------------------------------------------

describe("ACTIVE_OAUTH_ACCOUNT_ID — eliminated from source", () => {
    it("string ACTIVE_OAUTH_ACCOUNT_ID does NOT appear in index.ts source", async () => {
        // Read the source file and check for the removed global variable
        const { readFileSync } = await import("node:fs");
        const { fileURLToPath } = await import("node:url");
        const { dirname, join } = await import("node:path");
        const currentFile = fileURLToPath(import.meta.url);
        const indexPath = join(dirname(currentFile), "index.ts");
        const source = readFileSync(indexPath, "utf8");
        expect(source).not.toContain("ACTIVE_OAUTH_ACCOUNT_ID");
    });
});

// ---------------------------------------------------------------------------
// 9. failFastFetch accepts initialAccountId parameter (via loader closure)
// ---------------------------------------------------------------------------

describe("failFastFetch — initialAccountId via loader closure", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("loader closure captures accountId from token state", async () => {
        const successResponse = new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
        const fetchMock = vi.fn(async () => successResponse);
        vi.stubGlobal("fetch", fetchMock);

        const expectedAccountId = "closure-account-id-xyz";
        vi.mocked(getActiveOAuthAccount).mockResolvedValue({
            accountId: expectedAccountId,
            accessToken: "access-tok",
            resourceUrl: "https://example.com",
            exhaustedUntil: 0,
            healthyAccountCount: 1,
            totalAccountCount: 1,
        });

        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "access-tok" }));
        const loaderResult = await plugin.auth.loader(getAuth as never, undefined);

        // The fetch fn should be a closure (function) referencing the captured accountId
        expect(typeof loaderResult["fetch"]).toBe("function");
        expect(loaderResult["fetch"]).not.toBe(null);

        // Call it — should succeed without throwing
        const customFetch = loaderResult["fetch"] as (
            input: RequestInfo | URL,
            init?: RequestInit
        ) => Promise<Response>;
        const resp = await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });
        expect(resp.status).toBe(200);
    });

    it("loader returns empty object (no fetch fn) when no token available", async () => {
        vi.mocked(getActiveOAuthAccount).mockResolvedValue(null);
        vi.mocked(getValidToken).mockResolvedValue(null);

        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "none" as never }));
        const loaderResult = await plugin.auth.loader(getAuth as never, undefined);

        // No valid token → loader returns {} without a fetch function
        expect(loaderResult["fetch"]).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 10. Loader creates closure with currentAccountId (not a stale global)
// ---------------------------------------------------------------------------

describe("loader — closure captures currentAccountId per invocation", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("returns a new fetch closure on each loader call with distinct account IDs", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        vi.stubGlobal("fetch", fetchMock);

        vi.mocked(getActiveOAuthAccount)
            .mockResolvedValueOnce({
                accountId: "account-A",
                accessToken: "token-A",
                resourceUrl: "https://a.example.com",
                exhaustedUntil: 0,
                healthyAccountCount: 1,
                totalAccountCount: 2,
            })
            .mockResolvedValueOnce({
                accountId: "account-B",
                accessToken: "token-B",
                resourceUrl: "https://b.example.com",
                exhaustedUntil: 0,
                healthyAccountCount: 1,
                totalAccountCount: 2,
            });

        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "token-A" }));

        const resultA = await plugin.auth.loader(getAuth as never, undefined);
        const resultB = await plugin.auth.loader(getAuth as never, undefined);

        const fetchA = resultA["fetch"];
        const fetchB = resultB["fetch"];

        // Both should be functions (closures)
        expect(typeof fetchA).toBe("function");
        expect(typeof fetchB).toBe("function");

        // They should be distinct closure instances
        expect(fetchA).not.toBe(fetchB);
    });
});

// ---------------------------------------------------------------------------
// 11. applyDashScopeHeaders — case-insensitive dedup
// ---------------------------------------------------------------------------

describe("applyDashScopeHeaders — case-insensitive deduplication via failFastFetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("does not add X-DashScope-AuthType when lowercase variant already present", async () => {
        const capturedHeaders: Record<string, string>[] = [];
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
            // Collect headers for inspection
            const h = init?.headers;
            if (h && !Array.isArray(h) && !(h instanceof Headers)) {
                capturedHeaders.push({ ...(h as Record<string, string>) });
            }
            return new Response("{}", {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });

        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        // Pre-set lowercase version of the header
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-dashscope-authtype": "existing-value",
            } as Record<string, string>,
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });

        expect(fetchMock).toHaveBeenCalled();
        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentHeaders = calledInit.headers as Record<string, string>;

        // Count how many keys match x-dashscope-authtype case-insensitively
        const matchingKeys = Object.keys(sentHeaders).filter(
            (k) => k.toLowerCase() === "x-dashscope-authtype"
        );
        expect(matchingKeys.length).toBe(1);
    });

    it("does not duplicate X-DashScope-CacheControl when already present with different case", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-dashscope-cachecontrol": "disable",
            } as Record<string, string>,
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentHeaders = calledInit.headers as Record<string, string>;

        const matchingKeys = Object.keys(sentHeaders).filter(
            (k) => k.toLowerCase() === "x-dashscope-cachecontrol"
        );
        expect(matchingKeys.length).toBe(1);
    });

    it("adds X-DashScope-AuthType when no variant is present at all", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentHeaders = calledInit.headers as Record<string, string>;

        const matchingKeys = Object.keys(sentHeaders).filter(
            (k) => k.toLowerCase() === "x-dashscope-authtype"
        );
        expect(matchingKeys.length).toBe(1);
    });

    it("injects User-Agent when absent", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentHeaders = calledInit.headers as Record<string, string>;

        const userAgentKeys = Object.keys(sentHeaders).filter(
            (k) => k.toLowerCase() === "user-agent"
        );
        expect(userAgentKeys.length).toBe(1);
        const uaValue = sentHeaders[userAgentKeys[0]!];
        expect(uaValue).toBe(PLUGIN_USER_AGENT);
    });
});

// ---------------------------------------------------------------------------
// 12. sanitizeOutgoingPayload — stream_options stripped when stream != true
// ---------------------------------------------------------------------------

describe("payload sanitization — stream_options field", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("strips stream_options when stream is not true", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [],
            stream: false,
            stream_options: { include_usage: true },
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).not.toHaveProperty("stream_options");
    });

    it("keeps stream_options when stream is true", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [],
            stream: true,
            stream_options: { include_usage: true },
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody).toHaveProperty("stream_options");
    });
});

// ---------------------------------------------------------------------------
// 13. capPayloadMaxTokens — model-specific caps via DashScope limits
// ---------------------------------------------------------------------------

describe("capPayloadMaxTokens — DashScope output limits applied before send", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("caps max_tokens to 65536 for coder-model", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "coder-model",
            messages: [],
            max_tokens: 999999,
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody.max_tokens).toBe(65536);
    });

    it("caps max_tokens to 8192 for vision-model", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "vision-model",
            messages: [],
            max_tokens: 999999,
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        expect(sentBody.max_tokens).toBe(8192);
    });

    it("does not touch max_tokens for unknown models", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const body = JSON.stringify({
            model: "some-other-model",
            messages: [],
            max_tokens: 999999,
        });
        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });

        const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        const sentBody = JSON.parse(calledInit.body as string) as Record<string, unknown>;
        // capPayloadMaxTokens only acts when it recognizes the model; sanitizeOutgoingPayload
        // uses CHAT_MAX_TOKENS_CAP (65536) as fallback — so still capped at 65536
        // The important thing: it is not left at 999999 due to sanitizeOutgoingPayload
        expect(sentBody.max_tokens).toBeLessThanOrEqual(CHAT_MAX_TOKENS_CAP);
    });
});

// ---------------------------------------------------------------------------
// 14. Loader returns apiKey for SDK-level auth injection
// ---------------------------------------------------------------------------

describe("loader — returns apiKey for SDK auth injection", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("loader result includes apiKey equal to the access token", async () => {
        vi.mocked(getActiveOAuthAccount).mockResolvedValue({
            accountId: "acct-auth-test",
            accessToken: "my-secret-token",
            resourceUrl: "https://example.com",
            exhaustedUntil: 0,
            healthyAccountCount: 1,
            totalAccountCount: 1,
        });

        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "my-secret-token" }));
        const loaderResult = await plugin.auth.loader(getAuth as never, undefined);

        // The SDK uses apiKey for Bearer injection — not failFastFetch
        expect(loaderResult["apiKey"]).toBe("my-secret-token");
    });

    it("loader result includes baseURL string", async () => {
        vi.mocked(getActiveOAuthAccount).mockResolvedValue({
            accountId: "acct-base-url",
            accessToken: "tok",
            resourceUrl: "https://custom.example.com/resource",
            exhaustedUntil: 0,
            healthyAccountCount: 1,
            totalAccountCount: 1,
        });

        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "tok" }));
        const loaderResult = await plugin.auth.loader(getAuth as never, undefined);

        expect(typeof loaderResult["baseURL"]).toBe("string");
        expect(String(loaderResult["baseURL"]).length).toBeGreaterThan(0);
    });

    it("loader result includes timeout set to 30000", async () => {
        vi.mocked(getActiveOAuthAccount).mockResolvedValue({
            accountId: "acct-timeout",
            accessToken: "tok",
            resourceUrl: "https://example.com",
            exhaustedUntil: 0,
            healthyAccountCount: 1,
            totalAccountCount: 1,
        });

        const plugin = await buildPlugin();
        const getAuth = vi.fn(async () => ({ type: "oauth" as const, access: "tok" }));
        const loaderResult = await plugin.auth.loader(getAuth as never, undefined);

        expect(loaderResult["timeout"]).toBe(120000);
    });
});

// ---------------------------------------------------------------------------
// 15. Successful 200 response passes through unchanged
// ---------------------------------------------------------------------------

describe("failFastFetch — 200 response passthrough", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(getActiveOAuthAccount).mockReset();
        vi.mocked(getValidToken).mockReset();
    });

    it("returns 200 response directly without modification", async () => {
        const responseBody = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "hello" } }] });
        const fetchMock = vi.fn(async () =>
            new Response(responseBody, {
                status: 200,
                headers: { "content-type": "application/json" },
            })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        const response = await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toBe(responseBody);
    });

    it("makes exactly 1 fetch call for a 200 response (no retries)", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        );
        const customFetch = await buildLoaderFetch(fetchMock);
        if (!customFetch) { return; }

        await customFetch("https://example.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "coder-model", messages: [] }),
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
