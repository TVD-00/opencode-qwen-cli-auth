/**
 * Tests for QwenAuthPlugin v3 — rewritten to match new clean architecture.
 *
 * Test structure mirrors the plugin's 4 hooks:
 *   1. Plugin exports
 *   2. config hook — provider registration
 *   3. chat.params hook — token cap
 *   4. chat.headers hook — DashScope headers
 *   5. auth.loader — returns correct options
 *   6. auth.loader fetch — 401 refresh, 429 account switch, DashScope headers
 *   7. auth methods — primary + add-account
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
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

vi.mock("./lib/auth/browser.js", () => ({
  openBrowserUrl: vi.fn(),
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

import QwenAuthPlugin, {
  QwenAuthPlugin as QwenAuthPluginNamed,
} from "./index.js";
import {
  getActiveOAuthAccount,
  getValidToken,
  markOAuthAccountQuotaExhausted,
  switchToNextHealthyOAuthAccount,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "qwen-code";
const CHAT_MAX_TOKENS_CAP = 65536;
const PLUGIN_USER_AGENT_RE = /^QwenCode\//;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildPlugin() {
  return QwenAuthPlugin({} as never);
}

function mockActiveAccount(overrides: Record<string, unknown> = {}) {
  vi.mocked(getActiveOAuthAccount).mockResolvedValue({
    accountId: "acct-1",
    accessToken: "tok-1",
    resourceUrl: "https://example.com",
    exhaustedUntil: 0,
    healthyAccountCount: 1,
    totalAccountCount: 1,
    ...overrides,
  } as never);
}

async function getLoaderFetch(
  fetchMock?: ReturnType<typeof vi.fn>,
): Promise<
  ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null
> {
  if (fetchMock) vi.stubGlobal("fetch", fetchMock);
  mockActiveAccount();
  const plugin = await buildPlugin();
  const getAuth = vi.fn(async () => ({
    type: "oauth" as const,
    access: "tok-1",
  }));
  const result = await plugin.auth.loader(getAuth as never, undefined);
  return (result["fetch"] as typeof globalThis.fetch) || null;
}

// ---------------------------------------------------------------------------
// 1. Plugin exports
// ---------------------------------------------------------------------------

describe("plugin exports", () => {
  it("default export is a function", () => {
    expect(typeof QwenAuthPlugin).toBe("function");
  });

  it("named export is same reference", () => {
    expect(QwenAuthPlugin).toBe(QwenAuthPluginNamed);
  });

  it("returns object with required hook keys", async () => {
    const plugin = await buildPlugin();
    expect(plugin).toHaveProperty("auth");
    expect(plugin).toHaveProperty("config");
    expect(plugin).toHaveProperty("chat.params");
    expect(plugin).toHaveProperty("chat.headers");
  });

  it("auth.provider matches PROVIDER_ID", async () => {
    const plugin = await buildPlugin();
    expect(plugin.auth.provider).toBe(PROVIDER_ID);
  });

  it("auth.methods has 2 entries", async () => {
    const plugin = await buildPlugin();
    expect(plugin.auth.methods).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. config hook
// ---------------------------------------------------------------------------

describe("config hook", () => {
  it("registers qwen-code provider with coder-model and vision-model", async () => {
    const plugin = await buildPlugin();
    const config: Record<string, unknown> = {};
    await plugin.config!(config);
    const providers = (config as { provider: Record<string, unknown> })
      .provider;
    expect(providers[PROVIDER_ID]).toBeDefined();
    const qwen = providers[PROVIDER_ID] as Record<string, unknown>;
    expect(qwen.name).toBe("Qwen Code");
    expect(qwen.npm).toBe("@ai-sdk/openai-compatible");
    const models = qwen.models as Record<string, Record<string, unknown>>;
    expect(models["coder-model"]).toBeDefined();
    expect(models["vision-model"]).toBeDefined();
  });

  it("sets timeout: false in provider options", async () => {
    const plugin = await buildPlugin();
    const config: Record<string, unknown> = {};
    await plugin.config!(config);
    const qwen = (config as { provider: Record<string, Record<string, unknown>> })
      .provider[PROVIDER_ID];
    expect((qwen.options as Record<string, unknown>).timeout).toBe(false);
  });

  it("coder-model has reasoning: true, vision-model has attachment: true", async () => {
    const plugin = await buildPlugin();
    const config: Record<string, unknown> = {};
    await plugin.config!(config);
    const models = (
      (config as { provider: Record<string, Record<string, unknown>> }).provider[
        PROVIDER_ID
      ].models as Record<string, Record<string, unknown>>
    );
    expect(models["coder-model"].reasoning).toBe(true);
    expect(models["vision-model"].attachment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. chat.params hook
// ---------------------------------------------------------------------------

describe("chat.params hook", () => {
  it("caps max_tokens above 65536", async () => {
    const plugin = await buildPlugin();
    const output = { max_tokens: 100_000, options: {} };
    await plugin["chat.params"]!({}, output);
    expect(output.max_tokens).toBe(CHAT_MAX_TOKENS_CAP);
  });

  it("leaves max_tokens unchanged when within limit", async () => {
    const plugin = await buildPlugin();
    const output = { max_tokens: 4096, options: {} };
    await plugin["chat.params"]!({}, output);
    expect(output.max_tokens).toBe(4096);
  });

  it("caps options.maxTokens above 65536", async () => {
    const plugin = await buildPlugin();
    const output: Record<string, unknown> = {
      options: { maxTokens: 100_000 },
    };
    await plugin["chat.params"]!({}, output);
    expect((output.options as Record<string, unknown>).maxTokens).toBe(
      CHAT_MAX_TOKENS_CAP,
    );
  });

  it("does not create max_tokens when absent", async () => {
    const plugin = await buildPlugin();
    const output: Record<string, unknown> = {};
    await plugin["chat.params"]!({}, output);
    expect(output.max_tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. chat.headers hook
// ---------------------------------------------------------------------------

describe("chat.headers hook", () => {
  it("sets required DashScope headers", async () => {
    const plugin = await buildPlugin();
    const output: Record<string, unknown> = {};
    await plugin["chat.headers"]!({}, output);
    const headers = (output as { headers: Record<string, string> }).headers;
    expect(headers["X-DashScope-CacheControl"]).toBe("enable");
    expect(headers["X-DashScope-AuthType"]).toBe("qwen-oauth");
    expect(headers["User-Agent"]).toMatch(PLUGIN_USER_AGENT_RE);
    expect(headers["X-DashScope-UserAgent"]).toMatch(PLUGIN_USER_AGENT_RE);
  });

  it("initialises headers when output.headers is missing", async () => {
    const plugin = await buildPlugin();
    const output: Record<string, unknown> = {};
    await plugin["chat.headers"]!({}, output);
    expect((output as { headers: Record<string, string> }).headers).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. auth.loader — returns correct options
// ---------------------------------------------------------------------------

describe("auth.loader", () => {
  afterEach(() => {
    vi.mocked(getActiveOAuthAccount).mockReset();
    vi.mocked(getValidToken).mockReset();
  });

  it("returns empty object when no token available", async () => {
    vi.mocked(getActiveOAuthAccount).mockResolvedValue(null);
    vi.mocked(getValidToken).mockResolvedValue(null);
    const plugin = await buildPlugin();
    const getAuth = vi.fn(async () => null);
    const result = await plugin.auth.loader(getAuth as never, undefined);
    expect(result).toEqual({});
  });

  it("returns apiKey, baseURL, timeout: false, fetch when token available", async () => {
    mockActiveAccount();
    const plugin = await buildPlugin();
    const getAuth = vi.fn(async () => ({
      type: "oauth" as const,
      access: "tok-1",
    }));
    const result = await plugin.auth.loader(getAuth as never, undefined);
    expect(result["apiKey"]).toBe("tok-1");
    expect(typeof result["baseURL"]).toBe("string");
    expect(result["timeout"]).toBe(false);
    expect(typeof result["fetch"]).toBe("function");
  });

  it("sets model cost to zero", async () => {
    mockActiveAccount();
    const plugin = await buildPlugin();
    const provider = {
      models: { "coder-model": { cost: { input: 1, output: 1 } } },
    };
    await plugin.auth.loader(vi.fn(async () => null) as never, provider);
    expect(provider.models["coder-model"].cost).toEqual({
      input: 0,
      output: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. auth.loader fetch — DashScope headers, 401 refresh, 429 switch
// ---------------------------------------------------------------------------

describe("auth.loader fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getActiveOAuthAccount).mockReset();
    vi.mocked(getValidToken).mockReset();
    vi.mocked(markOAuthAccountQuotaExhausted).mockReset();
    vi.mocked(switchToNextHealthyOAuthAccount).mockReset();
  });

  it("injects DashScope headers on every request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    await customFetch("https://example.com/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    const calledInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = calledInit.headers as Headers;
    expect(headers.get("X-DashScope-AuthType")).toBe("qwen-oauth");
    expect(headers.get("X-DashScope-CacheControl")).toBe("enable");
    expect(headers.get("User-Agent")).toMatch(PLUGIN_USER_AGENT_RE);
  });

  it("sets Authorization bearer from active account", async () => {
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 200 }),
    );
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    await customFetch("https://example.com/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    const calledInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = calledInit.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("retries once on 401 with refreshed token", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    });
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    const response = await customFetch(
      "https://example.com/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 429 when upstream responds with insufficient_quota and no healthy account", async () => {
    const quotaBody = JSON.stringify({
      error: { code: "insufficient_quota", message: "quota exceeded" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(quotaBody, {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.mocked(switchToNextHealthyOAuthAccount).mockResolvedValue(null);
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    const response = await customFetch(
      "https://example.com/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(429);
    expect(vi.mocked(markOAuthAccountQuotaExhausted)).toHaveBeenCalled();
  });

  it("retries with new account on 429 insufficient_quota when healthy account available", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "insufficient_quota",
              message: "quota exceeded",
            },
          }),
          { status: 429 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.mocked(switchToNextHealthyOAuthAccount).mockResolvedValue({
      accountId: "acct-2",
      accessToken: "tok-2",
      resourceUrl: "https://example2.com",
      exhaustedUntil: 0,
      healthyAccountCount: 1,
      totalAccountCount: 2,
    });
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    const response = await customFetch(
      "https://example.com/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes through 200 response without modification", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    const response = await customFetch(
      "https://example.com/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it("makes exactly 1 fetch call for a 200 response (no retries)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    await customFetch("https://example.com/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves non-quota 429 response body", async () => {
    const body = JSON.stringify({
      error: { code: "rate_limit_exceeded", message: "too many requests" },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 429 }));
    const customFetch = await getLoaderFetch(fetchMock);
    if (!customFetch) return;

    const response = await customFetch(
      "https://example.com/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).toContain("rate_limit_exceeded");
  });
});

// ---------------------------------------------------------------------------
// 7. auth methods — browser auto-open
// ---------------------------------------------------------------------------

describe("auth methods", () => {
  afterEach(() => {
    vi.mocked(openBrowserUrl).mockReset();
  });

  it("primary authorize calls openBrowserUrl", async () => {
    const { createPKCE, requestDeviceCode } = await import(
      "./lib/auth/auth.js"
    );
    vi.mocked(createPKCE).mockResolvedValue({
      challenge: "ch",
      verifier: "vr",
    });
    vi.mocked(requestDeviceCode).mockResolvedValue({
      device_code: "dc",
      user_code: "UC",
      verification_uri: "https://qwen.ai/device",
      verification_uri_complete: "https://qwen.ai/device?code=UC",
      expires_in: 600,
      interval: 5,
    });

    const plugin = await buildPlugin();
    const method = plugin.auth.methods[0];
    if (method.type !== "oauth") throw new Error("expected oauth");
    const result = await method.authorize();

    expect(result.url).toBe("https://qwen.ai/device?code=UC");
    expect(result.method).toBe("auto");
    expect(vi.mocked(openBrowserUrl)).toHaveBeenCalledWith(
      "https://qwen.ai/device?code=UC",
    );
  });

  it("add-account authorize calls openBrowserUrl", async () => {
    const { createPKCE, requestDeviceCode } = await import(
      "./lib/auth/auth.js"
    );
    vi.mocked(createPKCE).mockResolvedValue({
      challenge: "ch",
      verifier: "vr",
    });
    vi.mocked(requestDeviceCode).mockResolvedValue({
      device_code: "dc",
      user_code: "UC2",
      verification_uri: "https://qwen.ai/device",
      verification_uri_complete: "https://qwen.ai/device?code=UC2",
      expires_in: 600,
      interval: 5,
    });

    const plugin = await buildPlugin();
    const method = plugin.auth.methods[1];
    if (method.type !== "oauth") throw new Error("expected oauth");
    const result = await method.authorize();

    expect(vi.mocked(openBrowserUrl)).toHaveBeenCalledWith(
      "https://qwen.ai/device?code=UC2",
    );
    expect(result.method).toBe("auto");
  });
});
