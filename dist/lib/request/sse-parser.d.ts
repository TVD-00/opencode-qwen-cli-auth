/**
 * Server-Sent Events (SSE) parsing utilities
 * Handles parsing of SSE streams into structured events
 */
/**
 * Represents a parsed SSE event
 */
export interface SseEvent {
    /** Event type (e.g., 'message', 'response.done') */
    type?: string;
    /** Event data (parsed JSON or raw string) */
    data: unknown;
    /** Raw data string before parsing */
    rawData: string;
}
/**
 * Parse a single SSE frame into events
 * A frame is text between double newlines (\n\n)
 *
 * @param frame - SSE frame text
 * @returns Array of parsed events
 */
export declare function parseFrame(frame: string): SseEvent[];
/**
 * Check if an event indicates stream completion
 * @param event - SSE event to check
 * @returns True if this is a completion event
 */
export declare function isCompletionEvent(event: SseEvent): boolean;
/**
 * Check if an event contains content data
 * @param event - SSE event to check
 * @returns True if this event has content
 */
export declare function hasContent(event: SseEvent): boolean;
//# sourceMappingURL=sse-parser.d.ts.map