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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createPKCE, requestDeviceCode, pollForToken, getApiBaseUrl, saveToken, refreshAccessToken, loadStoredToken, getValidToken } from "./lib/auth/auth.js";
import { PROVIDER_ID, AUTH_LABELS, DEVICE_FLOW, PORTAL_HEADERS } from "./lib/constants.js";
import { logError, logInfo, logWarn, LOGGING_ENABLED } from "./lib/logger.js";
const CHAT_REQUEST_TIMEOUT_MS = 30000;
const CHAT_MAX_RETRIES = 0;
// Output token caps should match what qwen-code uses for DashScope.
// - coder-model: 64K output
// - vision-model: 8K output
// We still keep a default for safety.
const CHAT_MAX_TOKENS_CAP = 65536;
const CHAT_DEFAULT_MAX_TOKENS = 2048;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const QUOTA_DEGRADE_MAX_TOKENS = 1024;
const CLI_FALLBACK_TIMEOUT_MS = 8000;
const CLI_FALLBACK_MAX_BUFFER_CHARS = 1024 * 1024;
const ENABLE_CLI_FALLBACK = process.env.OPENCODE_QWEN_ENABLE_CLI_FALLBACK === "1";
const PLUGIN_USER_AGENT = "opencode-qwen-cli-auth/2.2.1";
// Match qwen-code output limits for DashScope OAuth.
const DASH_SCOPE_OUTPUT_LIMITS = {
    "coder-model": 65536,
    "vision-model": 8192,
};
function capPayloadMaxTokens(payload) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    const model = typeof payload.model === "string" ? payload.model : "";
    const normalizedModel = model.trim().toLowerCase();
    const limit = DASH_SCOPE_OUTPUT_LIMITS[normalizedModel];
    if (!limit) {
        return payload;
    }
    const next = { ...payload };
    let changed = false;
    if (typeof next.max_tokens === "number" && next.max_tokens > limit) {
        next.max_tokens = limit;
        changed = true;
    }
    if (typeof next.max_completion_tokens === "number" && next.max_completion_tokens > limit) {
        next.max_completion_tokens = limit;
        changed = true;
    }
    // Some clients use camelCase.
    if (typeof next.maxTokens === "number" && next.maxTokens > limit) {
        next.maxTokens = limit;
        changed = true;
    }
    if (next.options && typeof next.options === "object") {
        const options = { ...next.options };
        let optionsChanged = false;
        if (typeof options.max_tokens === "number" && options.max_tokens > limit) {
            options.max_tokens = limit;
            optionsChanged = true;
        }
        if (typeof options.max_completion_tokens === "number" && options.max_completion_tokens > limit) {
            options.max_completion_tokens = limit;
            optionsChanged = true;
        }
        if (typeof options.maxTokens === "number" && options.maxTokens > limit) {
            options.maxTokens = limit;
            optionsChanged = true;
        }
        if (optionsChanged) {
            next.options = options;
            changed = true;
        }
    }
    return changed ? next : payload;
}
const CLIENT_ONLY_BODY_FIELDS = new Set([
    "providerID",
    "provider",
    "sessionID",
    "modelID",
    "requestBodyValues",
    "metadata",
    "options",
    "debug",
]);
function resolveQwenCliCommand() {
    const fromEnv = process.env.QWEN_CLI_PATH;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
        return fromEnv.trim();
    }
    if (process.platform === "win32") {
        const candidates = [];
        if (process.env.APPDATA) {
            candidates.push(`${process.env.APPDATA}\\npm\\qwen.cmd`);
        }
        if (process.env.USERPROFILE) {
            candidates.push(`${process.env.USERPROFILE}\\AppData\\Roaming\\npm\\qwen.cmd`);
        }
        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return "qwen";
}
const QWEN_CLI_COMMAND = resolveQwenCliCommand();
function shouldUseShell(command) {
    return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}
function makeFailFastErrorResponse(status, code, message) {
    return new Response(JSON.stringify({
        error: {
            message,
            type: "invalid_request_error",
            param: null,
            code,
        },
    }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
function createRequestSignalWithTimeout(sourceSignal, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error("request_timeout")), timeoutMs);
    const onSourceAbort = () => controller.abort(sourceSignal?.reason);
    if (sourceSignal) {
        if (sourceSignal.aborted) {
            controller.abort(sourceSignal.reason);
        }
        else {
            sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutId);
            if (sourceSignal) {
                sourceSignal.removeEventListener("abort", onSourceAbort);
            }
        },
    };
}
function appendLimitedText(current, chunk) {
    const next = current + chunk;
    if (next.length <= CLI_FALLBACK_MAX_BUFFER_CHARS) {
        return next;
    }
    return next.slice(next.length - CLI_FALLBACK_MAX_BUFFER_CHARS);
}
function isRequestInstance(value) {
    return typeof Request !== "undefined" && value instanceof Request;
}
async function normalizeFetchInvocation(input, init) {
    const requestInit = init ? { ...init } : {};
    let requestInput = input;
    if (!isRequestInstance(input)) {
        return { requestInput, requestInit };
    }
    requestInput = input.url;
    if (!requestInit.method) {
        requestInit.method = input.method;
    }
    if (!requestInit.headers) {
        requestInit.headers = new Headers(input.headers);
    }
    if (requestInit.body === undefined) {
        try {
            requestInit.body = await input.clone().text();
        }
        catch (_error) {
        }
    }
    if (!requestInit.signal) {
        requestInit.signal = input.signal;
    }
    return { requestInput, requestInit };
}
function getHeaderValue(headers, headerName) {
    if (!headers) {
        return undefined;
    }
    const normalizedHeader = headerName.toLowerCase();
    if (headers instanceof Headers) {
        return headers.get(headerName) ?? headers.get(normalizedHeader) ?? undefined;
    }
    if (Array.isArray(headers)) {
        const pair = headers.find(([name]) => String(name).toLowerCase() === normalizedHeader);
        return pair ? String(pair[1]) : undefined;
    }
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === normalizedHeader) {
            return value === undefined || value === null ? undefined : String(value);
        }
    }
    return undefined;
}
function applyJsonRequestBody(requestInit, payload) {
    requestInit.body = JSON.stringify(payload);
    if (!requestInit.headers) {
        requestInit.headers = { "content-type": "application/json" };
        return;
    }
    if (requestInit.headers instanceof Headers) {
        if (!requestInit.headers.has("content-type")) {
            requestInit.headers.set("content-type", "application/json");
        }
        return;
    }
    if (Array.isArray(requestInit.headers)) {
        const hasContentType = requestInit.headers.some(([name]) => String(name).toLowerCase() === "content-type");
        if (!hasContentType) {
            requestInit.headers.push(["content-type", "application/json"]);
        }
        return;
    }
    let hasContentType = false;
    for (const name of Object.keys(requestInit.headers)) {
        if (name.toLowerCase() === "content-type") {
            hasContentType = true;
            break;
        }
    }
    if (!hasContentType) {
        requestInit.headers["content-type"] = "application/json";
    }
}
function parseJsonRequestBody(requestInit) {
    if (typeof requestInit.body !== "string") {
        return null;
    }
    const contentType = getHeaderValue(requestInit.headers, "content-type");
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
        return null;
    }
    try {
        const parsed = JSON.parse(requestInit.body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    }
    catch (_error) {
        return null;
    }
}
function sanitizeOutgoingPayload(payload) {
    const sanitized = { ...payload };
    let changed = false;
    for (const field of CLIENT_ONLY_BODY_FIELDS) {
        if (field in sanitized) {
            delete sanitized[field];
            changed = true;
        }
    }
    if ("stream_options" in sanitized && sanitized.stream !== true) {
        delete sanitized.stream_options;
        changed = true;
    }
    if (typeof sanitized.max_tokens === "number" && sanitized.max_tokens > CHAT_MAX_TOKENS_CAP) {
        sanitized.max_tokens = CHAT_MAX_TOKENS_CAP;
        changed = true;
    }
    if (typeof sanitized.max_completion_tokens === "number" && sanitized.max_completion_tokens > CHAT_MAX_TOKENS_CAP) {
        sanitized.max_completion_tokens = CHAT_MAX_TOKENS_CAP;
        changed = true;
    }
    return changed ? sanitized : payload;
}
function createQuotaDegradedPayload(payload) {
    const degraded = { ...payload };
    let changed = false;
    if ("tools" in degraded) {
        delete degraded.tools;
        changed = true;
    }
    if ("tool_choice" in degraded) {
        delete degraded.tool_choice;
        changed = true;
    }
    if ("parallel_tool_calls" in degraded) {
        delete degraded.parallel_tool_calls;
        changed = true;
    }
    if (degraded.stream !== false) {
        degraded.stream = false;
        changed = true;
    }
    if (typeof degraded.max_tokens !== "number" || degraded.max_tokens > QUOTA_DEGRADE_MAX_TOKENS) {
        degraded.max_tokens = QUOTA_DEGRADE_MAX_TOKENS;
        changed = true;
    }
    if (typeof degraded.max_completion_tokens === "number" && degraded.max_completion_tokens > QUOTA_DEGRADE_MAX_TOKENS) {
        degraded.max_completion_tokens = QUOTA_DEGRADE_MAX_TOKENS;
        changed = true;
    }
    return changed ? degraded : null;
}
function isInsufficientQuota(text) {
    if (!text) {
        return false;
    }
    try {
        const parsed = JSON.parse(text);
        const errorCode = parsed?.error?.code;
        return typeof errorCode === "string" && errorCode.toLowerCase() === "insufficient_quota";
    }
    catch (_error) {
        return text.toLowerCase().includes("insufficient_quota");
    }
}
function extractMessageText(content) {
    if (typeof content === "string") {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content.map((part) => {
        if (typeof part === "string") {
            return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
            return part.text;
        }
        return "";
    }).filter(Boolean).join("\n").trim();
}
function buildQwenCliPrompt(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user") {
            continue;
        }
        const text = extractMessageText(message.content);
        if (text) {
            return text;
        }
    }
    const merged = messages.slice(-6).map((message) => {
        const text = extractMessageText(message?.content);
        if (!text) {
            return "";
        }
        const role = typeof message?.role === "string" ? message.role.toUpperCase() : "UNKNOWN";
        return `${role}: ${text}`;
    }).filter(Boolean).join("\n\n");
    return merged || "Please respond to the latest user request.";
}
function parseQwenCliEvents(rawOutput) {
    const trimmed = rawOutput.trim();
    if (!trimmed) {
        return null;
    }
    const candidates = [trimmed];
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
        candidates.push(trimmed.slice(start, end + 1));
    }
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch (_error) {
        }
    }
    return null;
}
function extractQwenCliText(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === "result" && typeof event.result === "string" && event.result.trim()) {
            return event.result.trim();
        }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const content = event?.message?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        const text = content.map((part) => {
            if (part && typeof part === "object" && typeof part.text === "string") {
                return part.text;
            }
            return "";
        }).filter(Boolean).join("\n").trim();
        if (text) {
            return text;
        }
    }
    return null;
}
function createSseResponseChunk(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
}
function makeQwenCliCompletionResponse(model, content, context, streamMode) {
    if (LOGGING_ENABLED) {
        logInfo("Qwen CLI fallback returned completion", {
            request_id: context.requestId,
            sessionID: context.sessionID,
            modelID: model,
        });
    }
    if (streamMode) {
        const completionId = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(createSseResponseChunk({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                        {
                            index: 0,
                            delta: { role: "assistant", content },
                            finish_reason: null,
                        },
                    ],
                })));
                controller.enqueue(encoder.encode(createSseResponseChunk({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: "stop",
                        },
                    ],
                })));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
        return new Response(stream, {
            status: 200,
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                "x-qwen-cli-fallback": "1",
            },
        });
    }
    const body = {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content,
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "content-type": "application/json",
            "x-qwen-cli-fallback": "1",
        },
    });
}
async function runQwenCliFallback(payload, context, abortSignal) {
    const model = typeof payload?.model === "string" && payload.model.length > 0 ? payload.model : "coder-model";
    const streamMode = payload?.stream === true;
    const prompt = buildQwenCliPrompt(payload);
    const args = [prompt, "-o", "json", "--max-session-turns", "1", "--model", model];
    if (LOGGING_ENABLED) {
        logWarn("Attempting qwen CLI fallback after quota error", {
            request_id: context.requestId,
            sessionID: context.sessionID,
            modelID: model,
            command: QWEN_CLI_COMMAND,
        });
    }
    return await new Promise((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        let timer = null;
        let child = undefined;
        let abortHandler = undefined;
        const useShell = shouldUseShell(QWEN_CLI_COMMAND);
        const finalize = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            if (abortSignal && abortHandler) {
                abortSignal.removeEventListener("abort", abortHandler);
            }
            resolve(result);
        };
        if (abortSignal?.aborted) {
            finalize({
                ok: false,
                reason: "cli_aborted",
            });
            return;
        }
        try {
            child = spawn(QWEN_CLI_COMMAND, args, {
                shell: useShell,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            finalize({
                ok: false,
                reason: `cli_spawn_throw:${error instanceof Error ? error.message : String(error)}`,
            });
            return;
        }
        if (abortSignal) {
            abortHandler = () => {
                try {
                    child?.kill();
                }
                catch (_killError) {
                }
                finalize({
                    ok: false,
                    reason: "cli_aborted",
                });
            };
            abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
        timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch (_killError) {
            }
            finalize({
                ok: false,
                reason: "cli_timeout",
            });
        }, CLI_FALLBACK_TIMEOUT_MS);
        child.stdout.on("data", (chunk) => {
            stdout = appendLimitedText(stdout, chunk.toString());
        });
        child.stderr.on("data", (chunk) => {
            stderr = appendLimitedText(stderr, chunk.toString());
        });
        child.on("error", (error) => {
            finalize({
                ok: false,
                reason: `cli_spawn_error:${error instanceof Error ? error.message : String(error)}`,
            });
        });
        child.on("close", (exitCode) => {
            const events = parseQwenCliEvents(stdout);
            const content = events ? extractQwenCliText(events) : null;
            if (content) {
                finalize({
                    ok: true,
                    response: makeQwenCliCompletionResponse(model, content, context, streamMode),
                });
                return;
            }
            finalize({
                ok: false,
                reason: `cli_exit_${exitCode ?? -1}`,
                stderr: stderr.slice(-300),
                stdout: stdout.slice(-300),
            });
        });
    });
}
function makeQuotaFailFastResponse(text, sourceHeaders, context) {
    const headers = new Headers(sourceHeaders);
    headers.set("content-type", "application/json");
    const body = text || JSON.stringify({
        error: {
            message: "Qwen quota/rate limit reached",
            type: "invalid_request_error",
            param: null,
            code: "insufficient_quota",
        },
    });
    if (LOGGING_ENABLED) {
        logWarn("Qwen request failed with 429", {
            request_id: context.requestId,
            sessionID: context.sessionID,
            modelID: context.modelID,
            status: 429,
            body: body.slice(0, 300),
        });
    }
    return new Response(body, {
        status: 400,
        headers,
    });
}
async function sendWithTimeout(input, requestInit) {
    const composed = createRequestSignalWithTimeout(requestInit.signal, CHAT_REQUEST_TIMEOUT_MS);
    try {
        return await fetch(input, {
            ...requestInit,
            signal: composed.signal,
        });
    }
    finally {
        composed.cleanup();
    }
}
function applyDashScopeHeaders(requestInit) {
    // Ensure required DashScope OAuth headers are always present.
    // This mirrors qwen-code (DashScopeOpenAICompatibleProvider.buildHeaders) behavior.
    // NOTE: We intentionally do this in the fetch layer so it works even when
    // OpenCode does not call the `chat.headers` hook (older versions / API mismatch).
    const headersToApply = {
        "X-DashScope-AuthType": PORTAL_HEADERS.AUTH_TYPE_VALUE,
        "X-DashScope-CacheControl": "enable",
        "User-Agent": PLUGIN_USER_AGENT,
        "X-DashScope-UserAgent": PLUGIN_USER_AGENT,
    };
    if (!requestInit.headers) {
        requestInit.headers = { ...headersToApply };
        return;
    }
    if (requestInit.headers instanceof Headers) {
        for (const [key, value] of Object.entries(headersToApply)) {
            if (!requestInit.headers.has(key)) {
                requestInit.headers.set(key, value);
            }
        }
        return;
    }
    if (Array.isArray(requestInit.headers)) {
        const existing = new Set(requestInit.headers.map(([name]) => String(name).toLowerCase()));
        for (const [key, value] of Object.entries(headersToApply)) {
            if (!existing.has(key.toLowerCase())) {
                requestInit.headers.push([key, value]);
            }
        }
        return;
    }
    // Plain object
    for (const [key, value] of Object.entries(headersToApply)) {
        if (!(key in requestInit.headers)) {
            requestInit.headers[key] = value;
        }
    }
}
async function failFastFetch(input, init) {
    const normalized = await normalizeFetchInvocation(input, init);
    const requestInput = normalized.requestInput;
    const requestInit = normalized.requestInit;
    // Always inject DashScope OAuth headers at the fetch layer.
    // This ensures compatibility across OpenCode versions.
    applyDashScopeHeaders(requestInit);
    const sourceSignal = requestInit.signal;
    const rawPayload = parseJsonRequestBody(requestInit);
    const sessionID = typeof rawPayload?.sessionID === "string" ? rawPayload.sessionID : undefined;
    let payload = rawPayload;
    if (payload) {
        // Ensure we never exceed DashScope model output limits.
        const capped = capPayloadMaxTokens(payload);
        if (capped !== payload) {
            payload = capped;
            applyJsonRequestBody(requestInit, payload);
        }
        const sanitized = sanitizeOutgoingPayload(payload);
        if (sanitized !== payload) {
            payload = sanitized;
            applyJsonRequestBody(requestInit, payload);
        }
    }
    const context = {
        requestId: getHeaderValue(requestInit.headers, "x-request-id"),
        sessionID,
        modelID: typeof payload?.model === "string" ? payload.model : undefined,
    };
    if (LOGGING_ENABLED) {
        logInfo("Qwen request dispatch", {
            request_id: context.requestId,
            sessionID: context.sessionID,
            modelID: context.modelID,
            max_tokens: typeof payload?.max_tokens === "number" ? payload.max_tokens : undefined,
            max_completion_tokens: typeof payload?.max_completion_tokens === "number" ? payload.max_completion_tokens : undefined,
            message_count: Array.isArray(payload?.messages) ? payload.messages.length : undefined,
            stream: payload?.stream === true,
        });
    }
    try {
        let response = await sendWithTimeout(requestInput, requestInit);
        if (LOGGING_ENABLED) {
            logInfo("Qwen request response", {
                request_id: context.requestId,
                sessionID: context.sessionID,
                modelID: context.modelID,
                status: response.status,
                attempt: 1,
            });
        }
        if (response.status === 429) {
            const firstBody = await response.text().catch(() => "");
            if (payload && isInsufficientQuota(firstBody)) {
                const degradedPayload = createQuotaDegradedPayload(payload);
                if (degradedPayload) {
                    const fallbackInit = { ...requestInit };
                    applyJsonRequestBody(fallbackInit, degradedPayload);
                    if (LOGGING_ENABLED) {
                        logWarn("Retrying once with degraded payload after 429 insufficient_quota", {
                            request_id: context.requestId,
                            sessionID: context.sessionID,
                            modelID: context.modelID,
                            attempt: 2,
                        });
                    }
                    response = await sendWithTimeout(requestInput, fallbackInit);
                    if (LOGGING_ENABLED) {
                        logInfo("Qwen request response", {
                            request_id: context.requestId,
                            sessionID: context.sessionID,
                            modelID: context.modelID,
                            status: response.status,
                            attempt: 2,
                        });
                    }
                    if (response.status !== 429) {
                        return response;
                    }
                    const fallbackBody = await response.text().catch(() => "");
                    if (ENABLE_CLI_FALLBACK) {
                        const cliFallback = await runQwenCliFallback(payload, context, sourceSignal);
                        if (cliFallback.ok) {
                            return cliFallback.response;
                        }
                        if (cliFallback.reason === "cli_aborted") {
                            return makeFailFastErrorResponse(400, "request_aborted", "Qwen request was aborted");
                        }
                        if (LOGGING_ENABLED) {
                            logWarn("Qwen CLI fallback failed", {
                                request_id: context.requestId,
                                sessionID: context.sessionID,
                                modelID: context.modelID,
                                reason: cliFallback.reason,
                                stderr: cliFallback.stderr,
                            });
                        }
                    }
                    return makeQuotaFailFastResponse(fallbackBody, response.headers, context);
                }
                if (ENABLE_CLI_FALLBACK) {
                    const cliFallback = await runQwenCliFallback(payload, context, sourceSignal);
                    if (cliFallback.ok) {
                        return cliFallback.response;
                    }
                    if (cliFallback.reason === "cli_aborted") {
                        return makeFailFastErrorResponse(400, "request_aborted", "Qwen request was aborted");
                    }
                    if (LOGGING_ENABLED) {
                        logWarn("Qwen CLI fallback failed", {
                            request_id: context.requestId,
                            sessionID: context.sessionID,
                            modelID: context.modelID,
                            reason: cliFallback.reason,
                            stderr: cliFallback.stderr,
                        });
                    }
                }
            }
            return makeQuotaFailFastResponse(firstBody, response.headers, context);
        }
        return response;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lowered = message.toLowerCase();
        if (lowered.includes("aborted") || lowered.includes("timeout")) {
            logWarn("Qwen request timeout (fail-fast)", { timeoutMs: CHAT_REQUEST_TIMEOUT_MS, message });
            return makeFailFastErrorResponse(400, "request_timeout", `Qwen request timed out after ${CHAT_REQUEST_TIMEOUT_MS}ms`);
        }
        logError("Qwen upstream fetch failed", { message });
        return makeFailFastErrorResponse(400, "upstream_unavailable", "Qwen upstream request failed");
    }
}
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
 * Falls back to DashScope compatible-mode if not available.
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
                    fetch: failFastFetch,
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
                        limit: { context: 1048576, output: CHAT_MAX_TOKENS_CAP },
                        cost: { input: 0, output: 0 },
                        modalities: { input: ["text"], output: ["text"] },
                    },
                    "vision-model": {
                        id: "vision-model",
                        name: "Qwen VL Plus (vision)",
                        reasoning: false,
                        limit: { context: 131072, output: DASH_SCOPE_OUTPUT_LIMITS["vision-model"] },
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
                if (typeof output.max_tokens !== "number" || output.max_tokens > CHAT_MAX_TOKENS_CAP) {
                    output.max_tokens = CHAT_DEFAULT_MAX_TOKENS;
                }
                if (typeof output.max_completion_tokens !== "number" || output.max_completion_tokens > CHAT_MAX_TOKENS_CAP) {
                    output.max_completion_tokens = CHAT_DEFAULT_MAX_TOKENS;
                }
                if (typeof output.maxTokens !== "number" || output.maxTokens > CHAT_MAX_TOKENS_CAP) {
                    output.maxTokens = CHAT_DEFAULT_MAX_TOKENS;
                }
                if (typeof output.options.max_tokens !== "number" || output.options.max_tokens > CHAT_MAX_TOKENS_CAP) {
                    output.options.max_tokens = CHAT_DEFAULT_MAX_TOKENS;
                }
                if (typeof output.options.max_completion_tokens !== "number" || output.options.max_completion_tokens > CHAT_MAX_TOKENS_CAP) {
                    output.options.max_completion_tokens = CHAT_DEFAULT_MAX_TOKENS;
                }
                if (typeof output.options.maxTokens !== "number" || output.options.maxTokens > CHAT_MAX_TOKENS_CAP) {
                    output.options.maxTokens = CHAT_DEFAULT_MAX_TOKENS;
                }
                if (LOGGING_ENABLED) {
                    logInfo("Applied chat.params hotfix", {
                        sessionID: input?.sessionID,
                        modelID: input?.model?.id,
                        timeout: output.options.timeout,
                        maxRetries: output.options.maxRetries,
                        max_tokens: output.max_tokens,
                        max_completion_tokens: output.max_completion_tokens,
                        maxTokens: output.maxTokens,
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
