import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Logging configuration
export const LOGGING_ENABLED = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === "1";
export const DEBUG_ENABLED = process.env.DEBUG_QWEN_PLUGIN === "1" || LOGGING_ENABLED;
const LOG_DIR = join(homedir(), ".opencode", "logs", "qwen-plugin");
// Log startup message about logging state
if (LOGGING_ENABLED) {
    console.log("[qwen-oauth-plugin] Request logging ENABLED - logs will be saved to:", LOG_DIR);
}
if (DEBUG_ENABLED && !LOGGING_ENABLED) {
    console.log("[qwen-oauth-plugin] Debug logging ENABLED");
}
let requestCounter = 0;
/**
 * Log request data to file (only when LOGGING_ENABLED is true)
 * @param stage - The stage of the request (e.g., "before-transform", "after-transform")
 * @param data - The data to log
 */
export function logRequest(stage, data) {
    // Only log if explicitly enabled via environment variable
    if (!LOGGING_ENABLED)
        return;
    // Ensure log directory exists on first log
    if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const requestId = ++requestCounter;
    const filename = join(LOG_DIR, `request-${requestId}-${stage}.json`);
    try {
        writeFileSync(filename, JSON.stringify({
            timestamp,
            requestId,
            stage,
            ...data,
        }, null, 2), "utf8");
        console.log(`[qwen-oauth-plugin] Logged ${stage} to ${filename}`);
    }
    catch (e) {
        const error = e;
        console.error("[qwen-oauth-plugin] Failed to write log:", error.message);
    }
}
/**
 * Log debug information (only when DEBUG_ENABLED is true)
 * @param message - Debug message
 * @param data - Optional data to log
 */
export function logDebug(message, data) {
    if (!DEBUG_ENABLED)
        return;
    if (data !== undefined) {
        console.log(`[qwen-oauth-plugin] ${message}`, data);
    }
    else {
        console.log(`[qwen-oauth-plugin] ${message}`);
    }
}
/**
 * Log error (always enabled for important issues)
 * @param message - Error message
 * @param data - Optional data to log
 */
export function logError(message, data) {
    if (data !== undefined) {
        console.error(`[qwen-oauth-plugin] ${message}`, data);
    }
    else {
        console.error(`[qwen-oauth-plugin] ${message}`);
    }
}
/**
 * Log warning (always enabled for important issues)
 * @param message - Warning message
 * @param data - Optional data to log
 */
export function logWarn(message, data) {
    if (data !== undefined) {
        console.warn(`[qwen-oauth-plugin] ${message}`, data);
    }
    else {
        console.warn(`[qwen-oauth-plugin] ${message}`);
    }
}
/**
 * Log info message (always enabled)
 * @param message - Info message
 * @param data - Optional data to log
 */
export function logInfo(message, data) {
    if (data !== undefined) {
        console.log(`[qwen-oauth-plugin] ${message}`, data);
    }
    else {
        console.log(`[qwen-oauth-plugin] ${message}`);
    }
}
//# sourceMappingURL=logger.js.map