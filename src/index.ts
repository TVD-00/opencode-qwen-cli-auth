/**
 * @fileoverview Alibaba Qwen OAuth Authentication Plugin for opencode
 * Main plugin entry point implementing OAuth 2.0 Device Authorization Grant
 * Handles authentication, request transformation, and error recovery
 * 
 * Architecture:
 * - OAuth flow: PKCE + Device Code Grant (RFC 8628)
 * - Token management: Automatic refresh with file-based storage
 * - Request handling: Custom fetch wrapper with retry logic
 * - Error recovery: Quota degradation and CLI fallback
 * 
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @repository https://github.com/TVD-00/opencode-qwen-cli-auth
 * @version 2.4.1
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
    createPKCE,
    requestDeviceCode,
    pollForToken,
    getApiBaseUrl,
    saveToken,
    refreshAccessToken,
    loadStoredToken,
    getValidToken,
    upsertOAuthAccount,
    getActiveOAuthAccount,
    markOAuthAccountQuotaExhausted,
    switchToNextHealthyOAuthAccount,
} from "./lib/auth/auth.js";
import { PROVIDER_ID, AUTH_LABELS, DEVICE_FLOW, PORTAL_HEADERS, TOKEN_REFRESH_BUFFER_MS } from "./lib/constants.js";
import { logError, logInfo, logWarn, LOGGING_ENABLED } from "./lib/logger.js";
import type { Plugin } from "@opencode-ai/plugin";
import type { TokenSuccess, HeadersInput } from "./lib/types.js";

/** Request timeout — matches CLI's DEFAULT_TIMEOUT (120 seconds) */
const CHAT_REQUEST_TIMEOUT_MS = 120000;
/** Stream inactivity timeout — abort if no data chunk arrives within this window */
const STREAM_INACTIVITY_TIMEOUT_MS = 45000;
/** Maximum number of retry attempts for failed requests */
const CHAT_MAX_RETRIES = 3;
/** Output token cap for coder-model (64K tokens) */
const CHAT_MAX_TOKENS_CAP = 65536;
/** Maximum consecutive polling failures before aborting OAuth flow */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/** Reduced max tokens for quota degraded requests */
const QUOTA_DEGRADE_MAX_TOKENS = 1024;
/** Timeout for CLI fallback execution in milliseconds */
const CLI_FALLBACK_TIMEOUT_MS = 8000;
/** Maximum buffer size for CLI output in characters */
const CLI_FALLBACK_MAX_BUFFER_CHARS = 1024 * 1024;
/** Enable CLI fallback feature via environment variable */
const ENABLE_CLI_FALLBACK = process.env.OPENCODE_QWEN_ENABLE_CLI_FALLBACK === "1";
/** Qwen CLI version to mimic */
const QWEN_CLI_VERSION = "0.13.1";
/** Build User-Agent matching official QwenCode CLI format */
function buildQwenUserAgent(): string {
    return `QwenCode/${QWEN_CLI_VERSION} (${process.platform}; ${process.arch})`;
}
const PLUGIN_USER_AGENT = buildQwenUserAgent();
/** Output token limits per model for DashScope OAuth */
const DASH_SCOPE_OUTPUT_LIMITS: Record<string, number> = {
    "coder-model": 65536,
    "vision-model": 8192,
};

/** Minimum delay before first request in milliseconds (anti-burst) */
const PRE_REQUEST_JITTER_MIN_MS = 30;
/** Maximum delay before first request in milliseconds */
const PRE_REQUEST_JITTER_MAX_MS = 200;
/** Minimum gap between consecutive requests in milliseconds */
const INTER_REQUEST_GAP_MS = 600;
/** Timestamp of the last request sent */
let lastRequestTimestamp = 0;
/** Maximum concurrent inflight requests to DashScope API */
const MAX_CONCURRENT_REQUESTS = 2;
/** Maximum concurrent CLI fallback spawns */
const MAX_CONCURRENT_CLI_SPAWNS = 1;

/**
 * Generates a random delay within [min, max] range
 * Uses uniform distribution for natural-looking timing
 */
function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Simple async semaphore for concurrency control
 * Limits the number of concurrent operations to prevent burst detection and resource exhaustion
 */
class AsyncSemaphore {
    private current = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly max: number) {}

    async acquire(): Promise<void> {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        await new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
        this.current++;
    }

    release(): void {
        if (this.current <= 0) return; // guard against underflow from double-release
        this.current--;
        const next = this.waiters.shift();
        if (next) {
            next();
        }
    }
}

/** Semaphore to limit concurrent API requests */
const requestSemaphore = new AsyncSemaphore(MAX_CONCURRENT_REQUESTS);
/** Semaphore to limit concurrent CLI fallback spawns */
const cliFallbackSemaphore = new AsyncSemaphore(MAX_CONCURRENT_CLI_SPAWNS);

/**
 * Promise chain that serializes request timing decisions.
 * Each caller waits for the previous timing slot to complete before
 * reading/writing lastRequestTimestamp, preventing the lost-update race
 * where N concurrent callers all read the same stale timestamp.
 */
let timingChain: Promise<void> = Promise.resolve();

/**
 * Enforces minimum gap between requests and adds jitter.
 * Serialized via promise chain to prevent concurrent callers from
 * bypassing the inter-request gap.
 */
async function applyRequestTiming(): Promise<void> {
    const prev = timingChain;
    let resolveMine!: () => void;
    timingChain = new Promise<void>((r) => { resolveMine = r; });
    try {
        await prev; // wait for previous timing slot
        const now = Date.now();
        const elapsed = now - lastRequestTimestamp;

        if (lastRequestTimestamp > 0 && elapsed < INTER_REQUEST_GAP_MS) {
            // Enforce inter-request gap with slight randomization
            const gapWait = INTER_REQUEST_GAP_MS - elapsed + randomDelay(0, 100);
            await new Promise((r) => setTimeout(r, gapWait));
        } else {
            // Pre-request jitter for first request or after long gap
            const jitter = randomDelay(PRE_REQUEST_JITTER_MIN_MS, PRE_REQUEST_JITTER_MAX_MS);
            await new Promise((r) => setTimeout(r, jitter));
        }

        lastRequestTimestamp = Date.now();
    } finally {
        resolveMine(); // unblock next waiter even if we threw
    }
}

/**
 * Calculates retry delay using exponential backoff with ±30% jitter
 * Matches the official Qwen CLI retry strategy exactly
 * @param attempt - Current retry attempt (0-based)
 * @param initialDelayMs - Base delay for first retry (default 1500ms)
 * @param maxDelayMs - Maximum delay cap (default 30000ms)
 * @returns Delay in milliseconds with jitter applied
 */
function calculateRetryDelay(attempt: number, initialDelayMs = 1500, maxDelayMs = 30000): number {
    const baseDelay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
    const jitterFactor = 0.3 * (Math.random() * 2 - 1); // ±30%
    return Math.max(0, Math.floor(baseDelay * (1 + jitterFactor)));
}

/** Session ID for metadata — generated once per plugin load, mimics CLI behavior */
const SESSION_ID = randomUUID();

/** Generate a per-request prompt ID for metadata */
function generatePromptId(): string {
    return randomUUID();
}

/**
 * Request context for logging and tracking
 */
interface RequestContext {
    requestId: string | undefined;
    sessionID: string | undefined;
    modelID: string | undefined;
    accountID: string | null;
}

/**
 * Result from CLI fallback execution
 */
interface CliFallbackResult {
    ok: boolean;
    response?: Response;
    reason?: string;
    stdout?: string;
    stderr?: string;
}

/**
 * Payload with optional token and request fields
 */
interface RequestPayload {
    model?: string;
    messages?: unknown[];
    stream?: boolean;
    max_tokens?: number;
    max_completion_tokens?: number;
    maxTokens?: number;
    options?: Record<string, unknown>;
    sessionID?: string;
    stream_options?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    parallel_tool_calls?: unknown;
    [key: string]: unknown;
}

function capPayloadMaxTokens(payload: RequestPayload): RequestPayload {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    const model = typeof payload.model === "string" ? payload.model : "";
    const normalizedModel = model.trim().toLowerCase();
    const limit = DASH_SCOPE_OUTPUT_LIMITS[normalizedModel];
    if (!limit) {
        return payload;
    }
    const next: RequestPayload = { ...payload };
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
        const options = { ...next.options } as Record<string, unknown>;
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
    "options",
    "debug",
]);

function resolveQwenCliCommand(): string {
    const fromEnv = process.env.QWEN_CLI_PATH;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
        return fromEnv.trim();
    }
    if (process.platform === "win32") {
        const candidates: string[] = [];
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

function requiresShellExecution(command: string): boolean {
    return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function makeFailFastErrorResponse(status: number, code: string, message: string): Response {
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

/**
 * Creates AbortSignal with timeout that composes with source signal
 * Properly cleans up timers and event listeners
 * @param {AbortSignal} [sourceSignal] - Original abort signal from caller
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {{ signal: AbortSignal, cleanup: () => void }} Composed signal and cleanup function
 */
function createRequestSignalWithTimeout(
    sourceSignal: AbortSignal | null | undefined,
    timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error("request_timeout")), timeoutMs);
    const onSourceAbort = () => controller.abort(sourceSignal?.reason);
    if (sourceSignal) {
        if (sourceSignal.aborted) {
            controller.abort(sourceSignal.reason);
        } else {
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

/**
 * Appends text chunk with size limit to prevent memory overflow
 * @param {string} current - Current text buffer
 * @param {string} chunk - New chunk to append
 * @returns {string} Combined text with size limit
 */
function appendLimitedText(current: string, chunk: string): string {
    const next = current + chunk;
    if (next.length <= CLI_FALLBACK_MAX_BUFFER_CHARS) {
        return next;
    }
    return next.slice(next.length - CLI_FALLBACK_MAX_BUFFER_CHARS);
}

/**
 * Checks if value is a Request instance
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a Request instance
 */
function isRequestInstance(value: unknown): value is Request {
    return typeof Request !== "undefined" && value instanceof Request;
}

/**
 * Normalizes fetch invocation from Request object or URL string
 * @param {Request|string} input - Fetch input
 * @param {RequestInit} [init] - Fetch options
 * @returns {{ requestInput: *, requestInit: RequestInit }} Normalized fetch parameters
 */
async function normalizeFetchInvocation(
    input: Request | string,
    init?: RequestInit,
): Promise<{ requestInput: string; requestInit: RequestInit }> {
    const requestInit: RequestInit = init ? { ...init } : {};
    let requestInput: string = isRequestInstance(input) ? input.url : (input as string);
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
        } catch (_error: unknown) {
            // ignore
        }
    }
    if (!requestInit.signal) {
        requestInit.signal = input.signal;
    }
    return { requestInput, requestInit };
}

/**
 * Gets header value from Headers object, array, or plain object
 * @param {Headers|Array|Object} headers - Headers to search
 * @param {string} headerName - Header name (case-insensitive)
 * @returns {string|undefined} Header value or undefined
 */
function getHeaderValue(headers: HeadersInput | null | undefined, headerName: string): string | undefined {
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

function applyAuthorizationHeader(requestInit: RequestInit, accessToken: string): void {
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        return;
    }
    const bearer = `Bearer ${accessToken}`;
    if (!requestInit.headers) {
        requestInit.headers = { authorization: bearer };
        return;
    }
    if (requestInit.headers instanceof Headers) {
        requestInit.headers.set("authorization", bearer);
        return;
    }
    if (Array.isArray(requestInit.headers)) {
        const existing = requestInit.headers.findIndex(([name]) => String(name).toLowerCase() === "authorization");
        if (existing >= 0) {
            requestInit.headers[existing][1] = bearer;
            return;
        }
        requestInit.headers.push(["authorization", bearer]);
        return;
    }
    let existingKey: string | null = null;
    for (const key of Object.keys(requestInit.headers as Record<string, string>)) {
        if (key.toLowerCase() === "authorization") {
            existingKey = key;
            break;
        }
    }
    if (existingKey) {
        (requestInit.headers as Record<string, string>)[existingKey] = bearer;
        return;
    }
    (requestInit.headers as Record<string, string>)["authorization"] = bearer;
}

function rewriteRequestBaseUrl(requestInput: string, resourceUrl: string): string {
    if (typeof requestInput !== "string" || typeof resourceUrl !== "string" || resourceUrl.length === 0) {
        return requestInput;
    }
    try {
        const targetBase = new URL(getApiBaseUrl(resourceUrl));
        const current = new URL(requestInput);
        const baseSegments = targetBase.pathname.split("/").filter(Boolean);
        const currentSegments = current.pathname.split("/").filter(Boolean);
        let suffix = currentSegments;
        if (
            currentSegments.length >= baseSegments.length &&
            baseSegments.every((segment, index) => currentSegments[index] === segment)
        ) {
            suffix = currentSegments.slice(baseSegments.length);
        }
        const mergedPath = [...baseSegments, ...suffix].join("/");
        targetBase.pathname = `/${mergedPath}`.replace(/\/+/g, "/");
        targetBase.search = current.search;
        targetBase.hash = current.hash;
        return targetBase.toString();
    } catch (_error: unknown) {
        return requestInput;
    }
}

/**
 * Applies JSON request body with proper content-type header
 * @param {RequestInit} requestInit - Fetch options
 * @param {Object} payload - Request payload
 */
function applyJsonRequestBody(requestInit: RequestInit, payload: RequestPayload): void {
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
    for (const name of Object.keys(requestInit.headers as Record<string, string>)) {
        if (name.toLowerCase() === "content-type") {
            hasContentType = true;
            break;
        }
    }
    if (!hasContentType) {
        (requestInit.headers as Record<string, string>)["content-type"] = "application/json";
    }
}

/**
 * Parses JSON request body if content-type is application/json
 * @param {RequestInit} requestInit - Fetch options
 * @returns {Object|null} Parsed payload or null
 */
function parseJsonRequestBody(requestInit: RequestInit): RequestPayload | null {
    if (typeof requestInit.body !== "string") {
        return null;
    }
    const contentType = getHeaderValue(requestInit.headers as HeadersInput, "content-type");
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
        return null;
    }
    try {
        const parsed = JSON.parse(requestInit.body) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as RequestPayload;
    } catch (_error: unknown) {
        return null;
    }
}

/**
 * Removes client-only fields and caps max_tokens
 * @param {Object} payload - Request payload
 * @returns {Object} Sanitized payload
 */
function sanitizeOutgoingPayload(payload: RequestPayload): RequestPayload {
    const sanitized: RequestPayload = { ...payload };
    let changed = false;
    // Remove client-only fields
    for (const field of CLIENT_ONLY_BODY_FIELDS) {
        if (field in sanitized) {
            delete sanitized[field];
            changed = true;
        }
    }
    // Remove stream_options if stream is not enabled
    if ("stream_options" in sanitized && sanitized.stream !== true) {
        delete sanitized.stream_options;
        changed = true;
    }
    // Cap max_tokens fields
    if (typeof sanitized.max_tokens === "number" && sanitized.max_tokens > CHAT_MAX_TOKENS_CAP) {
        sanitized.max_tokens = CHAT_MAX_TOKENS_CAP;
        changed = true;
    }
    if (typeof sanitized.max_completion_tokens === "number" && sanitized.max_completion_tokens > CHAT_MAX_TOKENS_CAP) {
        sanitized.max_completion_tokens = CHAT_MAX_TOKENS_CAP;
        changed = true;
    }
    // Inject DashScope metadata to match CLI fingerprint
    if (!("metadata" in sanitized) || !sanitized.metadata) {
        sanitized.metadata = {
            sessionId: SESSION_ID,
            promptId: generatePromptId(),
        };
        changed = true;
    } else if (typeof sanitized.metadata === "object" && sanitized.metadata !== null) {
        // Deep-copy metadata to avoid mutating the caller's object under concurrency
        const meta = { ...(sanitized.metadata as Record<string, unknown>) };
        sanitized.metadata = meta;
        if (!meta.sessionId) {
            meta.sessionId = SESSION_ID;
            changed = true;
        }
        if (!meta.promptId) {
            meta.promptId = generatePromptId();
            changed = true;
        }
    }
    return changed ? sanitized : payload;
}

/**
 * Creates degraded payload for quota error recovery
 * Removes tools and reduces max_tokens to 1024
 * @param {Object} payload - Original payload
 * @returns {Object|null} Degraded payload or null if no changes needed
 */
function createQuotaDegradedPayload(payload: RequestPayload): RequestPayload | null {
    const degraded: RequestPayload = { ...payload };
    let changed = false;
    // Remove tool-related fields
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
    // Disable streaming
    if (degraded.stream !== false) {
        degraded.stream = false;
        changed = true;
    }
    if ("stream_options" in degraded) {
        delete degraded.stream_options;
        changed = true;
    }
    // Reduce max_tokens
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

/**
 * Checks if response text contains insufficientQuota error
 * @param {string} text - Response body text
 * @returns {boolean} True if insufficient quota error
 */
function isInsufficientQuota(text: string): boolean {
    if (!text) {
        return false;
    }
    try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown } };
        const errorCode = parsed?.error?.code;
        return typeof errorCode === "string" && errorCode.toLowerCase() === "insufficient_quota";
    } catch (_error: unknown) {
        return text.toLowerCase().includes("insufficient_quota");
    }
}

/**
 * Extracts text content from message (handles string or array format)
 * @param {string|Array} content - Message content
 * @returns {string} Extracted text
 */
function extractMessageText(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return (content as unknown[]).map((part) => {
        if (typeof part === "string") {
            return part;
        }
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
        }
        return "";
    }).filter(Boolean).join("\n").trim();
}

/**
 * Checks whether content contains non-text parts
 * @param {*} content - Message content
 * @returns {boolean} True if any non-text part is present
 */
function hasNonTextContentPart(content: unknown): boolean {
    if (typeof content === "string") {
        return false;
    }
    if (Array.isArray(content)) {
        return (content as unknown[]).some((part) => {
            if (typeof part === "string") {
                return false;
            }
            if (!part || typeof part !== "object") {
                return true;
            }
            const p = part as { text?: unknown; type?: unknown };
            if (typeof p.text === "string") {
                return false;
            }
            const partType = typeof p.type === "string" ? p.type.toLowerCase() : "";
            if (partType === "text" && typeof p.text === "string") {
                return false;
            }
            return true;
        });
    }
    if (content && typeof content === "object") {
        return typeof (content as { text?: unknown }).text !== "string";
    }
    return false;
}

/**
 * Checks whether payload contains any multimodal message content
 * @param {Object} payload - Request payload
 * @returns {boolean} True if payload contains non-text message parts
 */
function payloadContainsNonTextMessages(payload: RequestPayload | null): boolean {
    const messages = Array.isArray(payload?.messages) ? payload!.messages : [];
    for (const message of messages) {
        if (hasNonTextContentPart((message as { content?: unknown })?.content)) {
            return true;
        }
    }
    return false;
}

/**
 * Builds prompt text from chat messages for CLI fallback
 * @param {Object} payload - Request payload with messages
 * @returns {string} Prompt text for qwen CLI
 */
function buildQwenCliPrompt(payload: RequestPayload | null): string {
    const messages = Array.isArray(payload?.messages) ? payload!.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: unknown; content?: unknown } | null;
        if (message?.role !== "user") {
            continue;
        }
        const text = extractMessageText(message.content);
        if (text) {
            return text;
        }
    }
    const merged = messages.slice(-6).map((message) => {
        const msg = message as { role?: unknown; content?: unknown } | null;
        const text = extractMessageText(msg?.content);
        if (!text) {
            return "";
        }
        const role = typeof msg?.role === "string" ? msg.role.toUpperCase() : "UNKNOWN";
        return `${role}: ${text}`;
    }).filter(Boolean).join("\n\n");
    return merged || "Please respond to the latest user request.";
}

/**
 * Parses qwen CLI JSON output events
 * @param {string} rawOutput - Raw CLI output
 * @returns {Array|null} Parsed events or null
 */
function parseQwenCliEvents(rawOutput: string): unknown[] | null {
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
            const parsed = JSON.parse(candidate) as unknown;
            if (Array.isArray(parsed)) {
                return parsed as unknown[];
            }
        } catch (_error: unknown) {
            // ignore
        }
    }
    return null;
}

/**
 * Extracts response text from CLI events
 * @param {Array} events - Parsed CLI events
 * @returns {string|null} Extracted text or null
 */
function extractQwenCliText(events: unknown[]): string | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index] as { type?: unknown; result?: unknown } | null;
        if (event?.type === "result" && typeof event.result === "string" && (event.result as string).trim()) {
            return (event.result as string).trim();
        }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index] as { message?: { content?: unknown } } | null;
        const content = event?.message?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        const text = (content as unknown[]).map((part) => {
            if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
                return (part as { text: string }).text;
            }
            return "";
        }).filter(Boolean).join("\n").trim();
        if (text) {
            return text;
        }
    }
    return null;
}

/**
 * Creates SSE formatted chunk for streaming responses
 * @param {Object} data - Data to stringify and send
 * @returns {string} SSE formatted string chunk
 */
function createSseResponseChunk(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Creates Response object matching OpenAI completion format
 * Handles both streaming (SSE) and non-streaming responses
 * @param {string} model - Model ID used
 * @param {string} content - Completion text content
 * @param {Object} context - Request context for logging
 * @param {boolean} streamMode - Whether to return streaming response
 * @returns {Response} Formatted completion response
 */
function makeQwenCliCompletionResponse(
    model: string,
    content: string,
    context: RequestContext,
    streamMode: boolean,
): Response {
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
                // Send first chunk with content
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
                // Send stop chunk
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
                // Send DONE marker
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
    // Non-streaming response format
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

/**
 * Executes qwen CLI as fallback when API quota is exceeded
 * @param {Object} payload - Original request payload
 * @param {Object} context - Request context for logging
 * @param {AbortSignal} [abortSignal] - Abort controller signal
 * @returns {Promise<{ ok: boolean, response?: Response, reason?: string, stdout?: string, stderr?: string }>} Fallback execution result
 */
async function runQwenCliFallback(
    payload: RequestPayload | null,
    context: RequestContext,
    abortSignal?: AbortSignal | null,
): Promise<CliFallbackResult> {
    const model =
        typeof payload?.model === "string" && payload.model.length > 0 ? payload.model : "coder-model";
    const streamMode = payload?.stream === true;
    if (payloadContainsNonTextMessages(payload)) {
        if (LOGGING_ENABLED) {
            logWarn("Skipping qwen CLI fallback for multimodal payload", {
                request_id: context.requestId,
                sessionID: context.sessionID,
                modelID: model,
                accountID: context.accountID,
            });
        }
        return {
            ok: false,
            reason: "cli_fallback_unsupported_multimodal_payload",
        };
    }
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
    if (requiresShellExecution(QWEN_CLI_COMMAND)) {
        return {
            ok: false,
            reason: "cli_shell_execution_blocked_for_security",
        };
    }
    return await new Promise<CliFallbackResult>((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        let timer: ReturnType<typeof setTimeout> | null = null;
        let child: ReturnType<typeof spawn> | undefined = undefined;
        let abortHandler: (() => void) | undefined = undefined;
        const finalize = (result: CliFallbackResult) => {
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
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error: unknown) {
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
                } catch (_killError: unknown) {
                    // ignore
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
                child!.kill();
            } catch (_killError: unknown) {
                // ignore
            }
            finalize({
                ok: false,
                reason: "cli_timeout",
            });
        }, CLI_FALLBACK_TIMEOUT_MS);
        child.stdout!.on("data", (chunk: Buffer) => {
            stdout = appendLimitedText(stdout, chunk.toString());
        });
        child.stderr!.on("data", (chunk: Buffer) => {
            stderr = appendLimitedText(stderr, chunk.toString());
        });
        child.on("error", (error: Error) => {
            finalize({
                ok: false,
                reason: `cli_spawn_error:${error instanceof Error ? error.message : String(error)}`,
            });
        });
        child.on("close", (exitCode: number | null) => {
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

/**
 * Creates Response object for quota/rate limit errors
 * @param {string} text - Response body text
 * @param {HeadersInit} sourceHeaders - Original response headers
 * @param {Object} context - Request context for logging
 * @returns {Response} Formatted error response
 */
function makeQuotaFailFastResponse(text: string, sourceHeaders: HeadersInit, context: RequestContext): Response {
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
        status: 429,
        headers,
    });
}

/**
 * Performs fetch request with timeout protection
 * @param {Request|string} input - Fetch input
 * @param {RequestInit} requestInit - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
async function sendWithTimeout(input: string, requestInit: RequestInit): Promise<Response> {
    const composed = createRequestSignalWithTimeout(requestInit.signal, CHAT_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(input, {
            ...requestInit,
            signal: composed.signal,
        });
        // For non-streaming or error responses, cleanup immediately
        // For streaming 200 responses, cleanup is deferred to wrapResponseWithStreamWatchdog
        if (!response.ok || !response.body) {
            composed.cleanup();
        }
        // Attach cleanup so the caller can defer it for streaming responses
        (response as ResponseWithCleanup).__timeoutCleanup = composed.cleanup;
        return response;
    } catch (error: unknown) {
        composed.cleanup();
        throw error;
    }
}

/** Extended Response type with deferred timeout cleanup */
interface ResponseWithCleanup extends Response {
    __timeoutCleanup?: () => void;
}

/**
 * Wraps a streaming Response body with an inactivity watchdog.
 * If no data chunk arrives within STREAM_INACTIVITY_TIMEOUT_MS, the stream is aborted.
 * This prevents indefinite hangs when the server stops sending data mid-stream.
 *
 * Also cleans up the original request timeout when the stream ends or aborts.
 *
 * @param response - The original fetch Response (must have a readable body)
 * @param inactivityTimeoutMs - Max ms allowed between consecutive data chunks
 * @returns A new Response with the watchdog-wrapped body
 */
function wrapResponseWithStreamWatchdog(
    response: Response,
    inactivityTimeoutMs: number = STREAM_INACTIVITY_TIMEOUT_MS,
): Response {
    const body = response.body;
    if (!body) {
        // No body to watch — clean up request timeout and return as-is
        (response as ResponseWithCleanup).__timeoutCleanup?.();
        return response;
    }

    const originalCleanup = (response as ResponseWithCleanup).__timeoutCleanup;
    const reader = body.getReader();
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;

    function resetWatchdog(controller: ReadableStreamDefaultController<Uint8Array>): void {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
            aborted = true;
            logWarn("Stream inactivity timeout — no data received", {
                timeoutMs: inactivityTimeoutMs,
            });
            controller.error(new Error(`Stream inactivity timeout after ${inactivityTimeoutMs}ms`));
            reader.cancel().catch(() => {});
            originalCleanup?.();
        }, inactivityTimeoutMs);
    }

    function clearWatchdog(): void {
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
        }
        originalCleanup?.();
    }

    const watchedStream = new ReadableStream<Uint8Array>({
        start(controller) {
            resetWatchdog(controller);
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    clearWatchdog();
                    controller.close();
                    return;
                }
                // Data received — reset the inactivity timer
                resetWatchdog(controller);
                controller.enqueue(value);
            } catch (error: unknown) {
                clearWatchdog();
                if (!aborted) {
                    controller.error(error);
                }
            }
        },
        cancel() {
            clearWatchdog();
            reader.cancel().catch(() => {});
        },
    });

    // Create a new Response with the watched stream, preserving headers/status
    const watchedResponse = new Response(watchedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });

    return watchedResponse;
}

/**
 * Injects required DashScope OAuth headers into fetch request
 * Ensures compatibility even if OpenCode doesn't call chat.headers hook
 * @param {RequestInit} requestInit - Fetch options to modify
 */
function applyDashScopeHeaders(requestInit: RequestInit): void {
    // Ensure required DashScope OAuth headers are always present.
    // This mirrors qwen-code (DashScopeOpenAICompatibleProvider.buildHeaders) behavior.
    // NOTE: We intentionally do this in the fetch layer so it works even when
    // OpenCode does not call the `chat.headers` hook (older versions / API mismatch).
    const headersToApply: Record<string, string> = {
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
        const existing = new Set((requestInit.headers as [string, string][]).map(([name]) => String(name).toLowerCase()));
        for (const [key, value] of Object.entries(headersToApply)) {
            if (!existing.has(key.toLowerCase())) {
                (requestInit.headers as [string, string][]).push([key, value]);
            }
        }
        return;
    }
    // Plain object
    const existingKeys = new Set(
        Object.keys(requestInit.headers as Record<string, string>).map((k) => k.toLowerCase())
    );
    for (const [key, value] of Object.entries(headersToApply)) {
        if (!existingKeys.has(key.toLowerCase())) {
            (requestInit.headers as Record<string, string>)[key] = value;
        }
    }
}

/**
 * Custom fetch wrapper for OpenCode SDK
 * Handles token limits, DashScope headers, retries, and quota error fallback
 * @param {Request|string} input - Fetch input
 * @param {RequestInit} [init] - Fetch options
 * @returns {Promise<Response>} API response or fallback response
 */
async function failFastFetch(input: Request | string, init?: RequestInit, initialAccountId?: string | null): Promise<Response> {
    const normalized = await normalizeFetchInvocation(input, init);
    let requestInput = normalized.requestInput;
    const requestInit = normalized.requestInit;
    // Always inject DashScope OAuth headers at the fetch layer.
    // This ensures compatibility across OpenCode versions.
    applyDashScopeHeaders(requestInit);
    const sourceSignal = requestInit.signal;
    const rawPayload = parseJsonRequestBody(requestInit);
    const sessionID = typeof rawPayload?.sessionID === "string" ? rawPayload.sessionID : undefined;
    let payload: RequestPayload | null = rawPayload;
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
    const context: RequestContext = {
        requestId: randomUUID(),
        sessionID,
        modelID: typeof payload?.model === "string" ? payload.model : undefined,
        accountID: initialAccountId || null,
    };
    if (LOGGING_ENABLED) {
        logInfo("Qwen request dispatch", {
            request_id: context.requestId,
            sessionID: context.sessionID,
            modelID: context.modelID,
            accountID: context.accountID,
            max_tokens: typeof payload?.max_tokens === "number" ? payload.max_tokens : undefined,
            max_completion_tokens:
                typeof payload?.max_completion_tokens === "number" ? payload.max_completion_tokens : undefined,
            message_count: Array.isArray(payload?.messages) ? payload!.messages.length : undefined,
            stream: payload?.stream === true,
        });
    }
    try {
        // Acquire semaphore slot — limits concurrent API requests to prevent burst detection
        await requestSemaphore.acquire();
        // Apply request timing to prevent burst detection
        await applyRequestTiming();
        let response = await sendWithTimeout(requestInput, requestInit);
        const MAX_REQUEST_RETRIES = CHAT_MAX_RETRIES;
        for (let retryAttempt = 0; retryAttempt < MAX_REQUEST_RETRIES; retryAttempt++) {
            if (LOGGING_ENABLED) {
                logInfo("Qwen request response", {
                    request_id: context.requestId,
                    sessionID: context.sessionID,
                    modelID: context.modelID,
                    accountID: context.accountID,
                    status: response.status,
                    attempt: retryAttempt + 1,
                });
            }
            const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];
            if (RETRYABLE_STATUS_CODES.includes(response.status)) {
                if (response.status === 429) {
                    const firstBody = await response.text().catch(() => "");
                    if (payload && isInsufficientQuota(firstBody)) {
                        if (context.accountID) {
                            try {
                                await markOAuthAccountQuotaExhausted(context.accountID, "insufficient_quota");
                                const switched = await switchToNextHealthyOAuthAccount([context.accountID]);
                                if (switched?.accessToken) {
                                    const rotatedInit: RequestInit = { ...requestInit };
                                    requestInput = rewriteRequestBaseUrl(requestInput, switched.resourceUrl ?? "");
                                    applyAuthorizationHeader(rotatedInit, switched.accessToken);
                                    applyAuthorizationHeader(requestInit, switched.accessToken);
                                    context.accountID = switched.accountId;
                                    if (LOGGING_ENABLED) {
                                        logInfo("Switched OAuth account after insufficient_quota", {
                                            request_id: context.requestId,
                                            sessionID: context.sessionID,
                                            modelID: context.modelID,
                                            accountID: context.accountID,
                                            healthyAccounts: switched.healthyAccountCount,
                                            totalAccounts: switched.totalAccountCount,
                                        });
                                    }
                                    response = await sendWithTimeout(requestInput, rotatedInit);
                                    if (retryAttempt < MAX_REQUEST_RETRIES) {
                                        continue;
                                    }
                                }
                            } catch (switchError: unknown) {
                                logWarn("Failed to switch OAuth account after insufficient_quota", switchError);
                            }
                        }
                        const degradedPayload = createQuotaDegradedPayload(payload);
                        if (degradedPayload) {
                            const fallbackInit: RequestInit = { ...requestInit };
                            applyJsonRequestBody(fallbackInit, degradedPayload);
                            if (LOGGING_ENABLED) {
                                logWarn(
                                    `Retrying with degraded payload after ${response.status} insufficient_quota, attempt ${retryAttempt + 2}/${MAX_REQUEST_RETRIES + 1}`,
                                    {
                                        request_id: context.requestId,
                                        sessionID: context.sessionID,
                                        modelID: context.modelID,
                                    },
                                );
                            }
                            response = await sendWithTimeout(requestInput, fallbackInit);
                            if (retryAttempt < MAX_REQUEST_RETRIES) {
                                continue;
                            }
                            const fallbackBody = await response.text().catch(() => "");
                            if (ENABLE_CLI_FALLBACK) {
                                await cliFallbackSemaphore.acquire();
                                try {
                                    const cliFallback = await runQwenCliFallback(
                                        payload,
                                        context,
                                        sourceSignal as AbortSignal | null | undefined,
                                    );
                                    if (cliFallback.ok) {
                                        return cliFallback.response!;
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
                                } finally {
                                    cliFallbackSemaphore.release();
                                }
                            }
                            return makeQuotaFailFastResponse(fallbackBody, response.headers, context);
                        }
                        if (ENABLE_CLI_FALLBACK) {
                            await cliFallbackSemaphore.acquire();
                            try {
                                const cliFallback = await runQwenCliFallback(
                                    payload,
                                    context,
                                    sourceSignal as AbortSignal | null | undefined,
                                );
                                if (cliFallback.ok) {
                                    return cliFallback.response!;
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
                            } finally {
                                cliFallbackSemaphore.release();
                            }
                        }
                    }
                    return makeQuotaFailFastResponse(firstBody, response.headers, context);
                }
                if (retryAttempt < MAX_REQUEST_RETRIES) {
                    if (LOGGING_ENABLED) {
                        logWarn(
                            `Retrying after ${response.status}, attempt ${retryAttempt + 2}/${MAX_REQUEST_RETRIES + 1}`,
                            {
                                request_id: context.requestId,
                                sessionID: context.sessionID,
                                modelID: context.modelID,
                            },
                        );
                    }
                    // Exponential backoff with ±30% jitter — matches CLI retry pattern
                    const retryDelay = calculateRetryDelay(retryAttempt);
                    await new Promise((r) => setTimeout(r, retryDelay));
                    // NOTE: 5xx retry uses original requestInit, not degraded payload.
                    // This is acceptable because 5xx errors are typically server-side transient failures,
                    // and the full payload is more likely to succeed than the degraded one.
                    response = await sendWithTimeout(requestInput, requestInit);
                    continue;
                }
            }
            return wrapResponseWithStreamWatchdog(response);
        }
        return wrapResponseWithStreamWatchdog(response);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const lowered = message.toLowerCase();
        if (lowered.includes("aborted") || lowered.includes("timeout")) {
            logWarn("Qwen request timeout (fail-fast)", { timeoutMs: CHAT_REQUEST_TIMEOUT_MS, message });
            return makeFailFastErrorResponse(
                400,
                "request_timeout",
                `Qwen request timed out after ${CHAT_REQUEST_TIMEOUT_MS}ms`,
            );
        }
        logError("Qwen upstream fetch failed", { message });
        return makeFailFastErrorResponse(400, "upstream_unavailable", "Qwen upstream request failed");
    } finally {
        requestSemaphore.release();
    }
}

/**
 * Get valid access token from SDK auth state, refresh if expired.
 * Uses getAuth() from SDK instead of reading file directly.
 *
 * @param {Function} getAuth - Function to get auth state from SDK
 * @returns {Promise<{ accessToken: string, resourceUrl?: string, accountId?: string }|null>} Access token state or null
 */
async function getValidAccessToken(
    getAuth: () => Promise<import("@opencode-ai/sdk").Auth>,
): Promise<{ accessToken: string; resourceUrl?: string; accountId?: string } | null> {
    const activeOAuthAccount = await getActiveOAuthAccount({ allowExhausted: false });
    if (activeOAuthAccount?.accessToken) {
        return {
            accessToken: activeOAuthAccount.accessToken,
            resourceUrl: activeOAuthAccount.resourceUrl,
            accountId: activeOAuthAccount.accountId,
        };
    }
    const diskToken = await getValidToken();
    if (diskToken?.accessToken) {
        return {
            accessToken: diskToken.accessToken,
            resourceUrl: diskToken.resourceUrl,
        };
    }
    const auth = await getAuth();
    if (!auth || auth.type !== "oauth") {
        return null;
    }
    let accessToken: string | undefined = auth.access;
    let resourceUrl: string | undefined = undefined;
    // Refresh if expired (using same buffer as auth.ts TOKEN_REFRESH_BUFFER_MS)
    if (accessToken && auth.expires && Date.now() > auth.expires - TOKEN_REFRESH_BUFFER_MS && auth.refresh) {
        try {
            const refreshResult = await refreshAccessToken(auth.refresh);
            if (refreshResult.type === "success") {
                accessToken = (refreshResult as TokenSuccess).access;
                resourceUrl = (refreshResult as TokenSuccess).resourceUrl;
                saveToken(refreshResult);
                await upsertOAuthAccount(refreshResult, {
                    setActive: false,
                    accountId: activeOAuthAccount?.accountId,
                });
            } else {
                if (LOGGING_ENABLED) {
                    logError("Token refresh failed");
                }
                accessToken = undefined;
            }
        } catch (e: unknown) {
            if (LOGGING_ENABLED) {
                logError("Token refresh error:", e);
            }
            accessToken = undefined;
        }
    }
    if (auth.access && auth.refresh) {
        try {
            const sdkToken: TokenSuccess = {
                type: "success",
                access: accessToken || auth.access,
                refresh: auth.refresh,
                expires: typeof auth.expires === "number" ? auth.expires : Date.now() + 3600 * 1000,
                resourceUrl,
            };
            saveToken(sdkToken);
            await upsertOAuthAccount(sdkToken, {
                setActive: false,
                accountId: activeOAuthAccount?.accountId,
            });
        } catch (e: unknown) {
            logWarn("Failed to bootstrap .qwen token from SDK auth state:", e);
        }
    }
    if (!accessToken) {
        return null;
    }
    return {
        accessToken,
        resourceUrl,
    };
}

/**
 * Get base URL from token stored on disk (resource_url).
 * Falls back to DashScope compatible-mode if not available.
 * @returns {string} DashScope API base URL
 */
function getBaseUrl(resourceUrl?: string): string {
    if (typeof resourceUrl === "string" && resourceUrl.length > 0) {
        return getApiBaseUrl(resourceUrl);
    }
    try {
        const stored = loadStoredToken();
        if (stored?.resource_url) {
            return getApiBaseUrl(stored.resource_url);
        }
    } catch (e: unknown) {
        logWarn("Failed to load stored token for baseURL, using default:", e);
    }
    return getApiBaseUrl();
}

/**
 * Alibaba Qwen OAuth authentication plugin for opencode
 * Integrates Qwen OAuth device flow and API handling into opencode SDK
 * 
 * @param {*} _input - Plugin initialization input
 * @returns {Promise<Object>} Plugin configuration and hooks
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-alibaba-qwen-cli-auth"],
 *   "model": "qwen-code/coder-model"
 * }
 * ```
 */
export const QwenAuthPlugin: Plugin = async (_input) => {
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
                        if (model) (model as { cost?: { input: number; output: number } }).cost = { input: 0, output: 0 };
                    }
                }
                const tokenState = await getValidAccessToken(getAuth);
                if (!tokenState?.accessToken) return {} as Record<string, unknown>;
                const currentAccountId = tokenState.accountId || null;
                const baseURL = getBaseUrl(tokenState.resourceUrl);
                if (LOGGING_ENABLED) {
                    logInfo("Using Qwen baseURL:", baseURL);
                }
                return {
                    apiKey: tokenState.accessToken,
                    baseURL,
                    timeout: CHAT_REQUEST_TIMEOUT_MS,
                    maxRetries: CHAT_MAX_RETRIES,
                    fetch: (input: RequestInfo | URL, init?: RequestInit) => failFastFetch(input as Request | string, init, currentAccountId),
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
                            method: "auto" as const,
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
                                    await new Promise((resolve) => setTimeout(resolve, pollInterval + POLLING_MARGIN_MS));
                                    const result = await pollForToken(deviceAuth.device_code, pkce.verifier);
                                    if (result.type === "success") {
                                        saveToken(result);
                                        await upsertOAuthAccount(result, { setActive: true });
                                        // Return to SDK to save auth state
                                        return {
                                            type: "success" as const,
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
                                            return { type: "failed" as const };
                                        }
                                        consecutivePollFailures += 1;
                                        logWarn(`OAuth token polling failed (${consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
                                        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                                            console.error("[qwen-oauth-plugin] OAuth token polling failed repeatedly");
                                            return { type: "failed" as const };
                                        }
                                        continue;
                                    }
                                    if (result.type === "denied") {
                                        console.error("[qwen-oauth-plugin] Device authorization was denied");
                                        return { type: "failed" as const };
                                    }
                                    if (result.type === "expired") {
                                        console.error("[qwen-oauth-plugin] Device authorization code expired");
                                        return { type: "failed" as const };
                                    }
                                    return { type: "failed" as const };
                                }
                                console.error("[qwen-oauth-plugin] Device authorization timed out");
                                return { type: "failed" as const };
                            },
                        };
                    },
                },
                {
                    label: "Add another Qwen account (multi-account switch)",
                    type: "oauth",
                    /**
                     * Them account Qwen phu de auto-switch khi account chinh het quota.
                     * Luon tao account moi (forceNew), khong ghi de account cu.
                     * Account moi khong duoc dat active ngay (setActive: false).
                     */
                    authorize: async () => {
                        const pkce = await createPKCE();
                        const deviceAuth = await requestDeviceCode(pkce);
                        if (!deviceAuth) {
                            throw new Error("Failed to request device code");
                        }
                        console.log(`\n[Add Account] Please visit: ${deviceAuth.verification_uri}`);
                        console.log(`[Add Account] Enter code: ${deviceAuth.user_code}\n`);
                        const verificationUrl = deviceAuth.verification_uri_complete || deviceAuth.verification_uri;
                        return {
                            url: verificationUrl,
                            method: "auto" as const,
                            instructions: "Login with a DIFFERENT Qwen account to add it as backup for auto-switch.",
                            callback: async () => {
                                let pollInterval = (deviceAuth.interval || 5) * 1000;
                                const POLLING_MARGIN_MS = 3000;
                                const maxInterval = DEVICE_FLOW.MAX_POLL_INTERVAL;
                                const startTime = Date.now();
                                const expiresIn = deviceAuth.expires_in * 1000;
                                let consecutivePollFailures = 0;
                                while (Date.now() - startTime < expiresIn) {
                                    await new Promise((resolve) => setTimeout(resolve, pollInterval + POLLING_MARGIN_MS));
                                    const result = await pollForToken(deviceAuth.device_code, pkce.verifier);
                                    if (result.type === "success") {
                                        // forceNew: luon tao account moi, khong match account cu
                                        // setActive: false - giu account hien tai, chi them du phong
                                        const savedAccount = await upsertOAuthAccount(result, {
                                            setActive: false,
                                            forceNew: true,
                                        });
                                        if (LOGGING_ENABLED) {
                                            logInfo("Added new backup Qwen account", {
                                                accountId: savedAccount?.accountId,
                                                totalAccounts: savedAccount?.totalAccountCount,
                                                healthyAccounts: savedAccount?.healthyAccountCount,
                                            });
                                        }
                                        console.log(
                                            `[Add Account] Success! Account added. Total accounts: ${savedAccount?.totalAccountCount || "?"}`,
                                        );
                                        // Khoi phuc legacy token file (oauth_creds.json) ve active account
                                        // de loader doc dung token cua account chinh, khong dung token account moi
                                        try {
                                            await getActiveOAuthAccount({ allowExhausted: true });
                                            // getActiveOAuthAccount auto-syncs active account token to oauth_creds.json
                                        } catch (_restoreError: unknown) {
                                            logWarn("Failed to restore active account after adding new account");
                                        }
                                        return {
                                            type: "success" as const,
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
                                            logError("OAuth token polling failed with fatal error (add-account)", {
                                                status: result.status,
                                                error: result.error,
                                                description: result.description,
                                            });
                                            return { type: "failed" as const };
                                        }
                                        consecutivePollFailures += 1;
                                        logWarn(
                                            `OAuth token polling failed (add-account) (${consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES})`,
                                        );
                                        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                                            console.error(
                                                "[qwen-oauth-plugin] OAuth token polling failed repeatedly (add-account)",
                                            );
                                            return { type: "failed" as const };
                                        }
                                        continue;
                                    }
                                    if (result.type === "denied") {
                                        console.error("[qwen-oauth-plugin] Device authorization was denied (add-account)");
                                        return { type: "failed" as const };
                                    }
                                    if (result.type === "expired") {
                                        console.error(
                                            "[qwen-oauth-plugin] Device authorization code expired (add-account)",
                                        );
                                        return { type: "failed" as const };
                                    }
                                    return { type: "failed" as const };
                                }
                                console.error("[qwen-oauth-plugin] Device authorization timed out (add-account)");
                                return { type: "failed" as const };
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
            const providers = (config as unknown as { provider?: Record<string, unknown> }).provider || {};
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
                        name: "Qwen 3.5 Plus",
                        attachment: false,
                        reasoning: true,
                        limit: { context: 1048576, output: CHAT_MAX_TOKENS_CAP },
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
                        limit: { context: 131072, output: DASH_SCOPE_OUTPUT_LIMITS["vision-model"] },
                        cost: { input: 0, output: 0 },
                        modalities: { input: ["text", "image"], output: ["text"] },
                    },
                },
            };
            (config as unknown as { provider?: Record<string, unknown> }).provider = providers;
        },
        /**
         * Apply dynamic chat parameters before sending request
         * Ensures tokens and timeouts don't exceed plugin limits
         * 
         * @param {*} input - Original chat request parameters
         * @param {*} output - Final payload to be sent
         */
        "chat.params": async (input, output) => {
            try {
                const out = output as Record<string, unknown> & {
                    options?: Record<string, unknown>;
                    max_tokens?: number;
                    max_completion_tokens?: number;
                    maxTokens?: number;
                };
                out.options = out.options || {};
                out.options.maxRetries = CHAT_MAX_RETRIES;
                if (typeof out.options.timeout !== "number" || (out.options.timeout as number) > CHAT_REQUEST_TIMEOUT_MS) {
                    out.options.timeout = CHAT_REQUEST_TIMEOUT_MS;
                }
                if (typeof out.max_tokens === "number" && out.max_tokens > CHAT_MAX_TOKENS_CAP) {
                    out.max_tokens = CHAT_MAX_TOKENS_CAP;
                }
                if (typeof out.max_completion_tokens === "number" && out.max_completion_tokens > CHAT_MAX_TOKENS_CAP) {
                    out.max_completion_tokens = CHAT_MAX_TOKENS_CAP;
                }
                if (typeof out.maxTokens === "number" && out.maxTokens > CHAT_MAX_TOKENS_CAP) {
                    out.maxTokens = CHAT_MAX_TOKENS_CAP;
                }
                if (
                    typeof out.options.max_tokens === "number" &&
                    (out.options.max_tokens as number) > CHAT_MAX_TOKENS_CAP
                ) {
                    out.options.max_tokens = CHAT_MAX_TOKENS_CAP;
                }
                if (
                    typeof out.options.max_completion_tokens === "number" &&
                    (out.options.max_completion_tokens as number) > CHAT_MAX_TOKENS_CAP
                ) {
                    out.options.max_completion_tokens = CHAT_MAX_TOKENS_CAP;
                }
                if (
                    typeof out.options.maxTokens === "number" &&
                    (out.options.maxTokens as number) > CHAT_MAX_TOKENS_CAP
                ) {
                    out.options.maxTokens = CHAT_MAX_TOKENS_CAP;
                }
                if (LOGGING_ENABLED) {
                    const inp = input as { sessionID?: string; model?: { id?: string } };
                    logInfo("Applied chat.params hotfix", {
                        sessionID: inp?.sessionID,
                        modelID: inp?.model?.id,
                        timeout: out.options.timeout,
                        maxRetries: out.options.maxRetries,
                        max_tokens: out.max_tokens,
                        max_completion_tokens: out.max_completion_tokens,
                        maxTokens: out.maxTokens,
                    });
                }
            } catch (e: unknown) {
                logWarn("Failed to apply chat params hotfix:", e);
            }
        },
        /**
         * Send DashScope headers like original CLI.
         * X-DashScope-CacheControl: enable prompt caching, reduce token consumption.
         * X-DashScope-AuthType: specify auth method for server.
         * 
         * @param {*} input - Original chat request parameters
         * @param {*} output - Final payload to be sent
         */
        "chat.headers": async (input: unknown, output: unknown) => {
            try {
                const out = output as Record<string, unknown> & { headers?: Record<string, string> };
                out.headers = out.headers || {};
                const requestId = randomUUID();
                out.headers["X-DashScope-CacheControl"] = "enable";
                out.headers[PORTAL_HEADERS.AUTH_TYPE] = PORTAL_HEADERS.AUTH_TYPE_VALUE;
                out.headers["User-Agent"] = PLUGIN_USER_AGENT;
                out.headers["X-DashScope-UserAgent"] = PLUGIN_USER_AGENT;
                // NOTE: x-request-id intentionally NOT sent — official CLI does not send it on API calls
                if (LOGGING_ENABLED) {
                    const inp = input as {
                        sessionID?: string;
                        model?: { id?: string };
                        provider?: { info?: { id?: string } };
                    };
                    logInfo("Applied chat.headers", {
                        request_id: requestId,
                        sessionID: inp?.sessionID,
                        modelID: inp?.model?.id,
                        providerID: inp?.provider?.info?.id,
                    });
                }
            } catch (e: unknown) {
                logWarn("Failed to set chat headers:", e);
            }
        },
    };
};

export default QwenAuthPlugin;
