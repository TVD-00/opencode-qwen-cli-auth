/**
 * @fileoverview Logging utilities for Qwen OAuth Plugin
 * Provides configurable logging for debugging and request tracing
 * @license MIT
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Flag to enable request logging to file
 * Controlled by ENABLE_PLUGIN_REQUEST_LOGGING environment variable
 * @constant {boolean}
 */
export const LOGGING_ENABLED = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === "1";

/**
 * Flag to enable debug logging to console
 * Controlled by DEBUG_QWEN_PLUGIN or ENABLE_PLUGIN_REQUEST_LOGGING environment variables
 * @constant {boolean}
 */
export const DEBUG_ENABLED = process.env.DEBUG_QWEN_PLUGIN === "1" || LOGGING_ENABLED;

/**
 * Directory path for log files
 * Logs are stored in ~/.opencode/logs/qwen-plugin/
 * @constant {string}
 */
const LOG_DIR = join(homedir(), ".opencode", "logs", "qwen-plugin");

// Log startup message about logging state
if (LOGGING_ENABLED) {
    console.log("[qwen-oauth-plugin] Request logging ENABLED - logs will be saved to:", LOG_DIR);
}
if (DEBUG_ENABLED && !LOGGING_ENABLED) {
    console.log("[qwen-oauth-plugin] Debug logging ENABLED");
}

/**
 * Request counter for generating unique request IDs in logs
 * @type {number}
 */
let requestCounter = 0;

/**
 * Log request data to file (only when LOGGING_ENABLED is true)
 * Creates JSON files with request/response data for debugging
 * @param {string} stage - The stage of the request (e.g., "before-transform", "after-transform", "response")
 * @param {Object} data - The data to log (request/response objects, metadata, etc.)
 * @returns {void}
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
 * Used for detailed debugging during development
 * @param {string} message - Debug message describing the context
 * @param {*} [data] - Optional data to log (objects, values, etc.)
 * @returns {void}
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
 * Used for critical errors that need attention
 * @param {string} message - Error message describing what went wrong
 * @param {*} [data] - Optional data to log (error objects, context, etc.)
 * @returns {void}
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
 * Used for non-critical issues that may need attention
 * @param {string} message - Warning message describing the issue
 * @param {*} [data] - Optional data to log (context, values, etc.)
 * @returns {void}
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
 * Used for general informational messages
 * @param {string} message - Info message describing the event
 * @param {*} [data] - Optional data to log (context, values, etc.)
 * @returns {void}
 */
export function logInfo(message, data) {
    if (data !== undefined) {
        console.log(`[qwen-oauth-plugin] ${message}`, data);
    }
    else {
        console.log(`[qwen-oauth-plugin] ${message}`);
    }
}
