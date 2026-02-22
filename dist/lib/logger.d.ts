export declare const LOGGING_ENABLED: boolean;
export declare const DEBUG_ENABLED: boolean;
/**
 * Log request data to file (only when LOGGING_ENABLED is true)
 * @param stage - The stage of the request (e.g., "before-transform", "after-transform")
 * @param data - The data to log
 */
export declare function logRequest(stage: string, data: Record<string, unknown>): void;
/**
 * Log debug information (only when DEBUG_ENABLED is true)
 * @param message - Debug message
 * @param data - Optional data to log
 */
export declare function logDebug(message: string, data?: unknown): void;
/**
 * Log error (always enabled for important issues)
 * @param message - Error message
 * @param data - Optional data to log
 */
export declare function logError(message: string, data?: unknown): void;
/**
 * Log warning (always enabled for important issues)
 * @param message - Warning message
 * @param data - Optional data to log
 */
export declare function logWarn(message: string, data?: unknown): void;
/**
 * Log info message (always enabled)
 * @param message - Info message
 * @param data - Optional data to log
 */
export declare function logInfo(message: string, data?: unknown): void;
//# sourceMappingURL=logger.d.ts.map