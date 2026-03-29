/**
 * @fileoverview Logging utilities for Qwen OAuth Plugin
 * Provides configurable logging for debugging and request tracing
 * @license MIT
 */
/**
 * Flag to enable request logging to file
 * Controlled by ENABLE_PLUGIN_REQUEST_LOGGING environment variable
 * @constant {boolean}
 */
export declare const LOGGING_ENABLED: boolean;
/**
 * Flag to enable debug logging to console
 * Controlled by DEBUG_QWEN_PLUGIN or ENABLE_PLUGIN_REQUEST_LOGGING environment variables
 * @constant {boolean}
 */
export declare const DEBUG_ENABLED: boolean;
/**
 * Log request data to file (only when LOGGING_ENABLED is true)
 * Creates JSON files with request/response data for debugging
 * @param stage - The stage of the request (e.g., "before-transform", "after-transform", "response")
 * @param data - The data to log (request/response objects, metadata, etc.)
 */
export declare function logRequest(stage: string, data: Record<string, unknown>): void;
/**
 * Log debug information (only when DEBUG_ENABLED is true)
 * Used for detailed debugging during development
 * @param message - Debug message describing the context
 * @param data - Optional data to log (objects, values, etc.)
 */
export declare function logDebug(message: string, data?: unknown): void;
/**
 * Log error (always enabled for important issues)
 * Used for critical errors that need attention
 * @param message - Error message describing what went wrong
 * @param data - Optional data to log (error objects, context, etc.)
 */
export declare function logError(message: string, data?: unknown): void;
/**
 * Log warning (always enabled for important issues)
 * Used for non-critical issues that may need attention
 * @param message - Warning message describing the issue
 * @param data - Optional data to log (context, values, etc.)
 */
export declare function logWarn(message: string, data?: unknown): void;
/**
 * Log info message (always enabled)
 * Used for general informational messages
 * @param message - Info message describing the event
 * @param data - Optional data to log (context, values, etc.)
 */
export declare function logInfo(message: string, data?: unknown): void;
//# sourceMappingURL=logger.d.ts.map