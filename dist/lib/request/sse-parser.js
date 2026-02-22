/**
 * Server-Sent Events (SSE) parsing utilities
 * Handles parsing of SSE streams into structured events
 */
/**
 * Parse a single SSE frame into events
 * A frame is text between double newlines (\n\n)
 *
 * @param frame - SSE frame text
 * @returns Array of parsed events
 */
export function parseFrame(frame) {
    const events = [];
    const lines = frame.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:'))
            continue;
        const dataStr = trimmed.slice(5).trim(); // Remove 'data:' prefix
        // Handle [DONE] marker
        if (dataStr === '[DONE]') {
            events.push({
                type: 'done',
                data: null,
                rawData: dataStr,
            });
            continue;
        }
        // Try to parse as JSON
        let payload = null;
        try {
            payload = JSON.parse(dataStr);
        }
        catch {
            // Not JSON, treat as raw string
            events.push({
                type: 'raw',
                data: dataStr,
                rawData: dataStr,
            });
            continue;
        }
        // Extract type from payload if available
        const payloadObj = payload;
        const type = payloadObj?.type || 'message';
        events.push({
            type,
            data: payload,
            rawData: dataStr,
        });
    }
    return events;
}
/**
 * Check if an event indicates stream completion
 * @param event - SSE event to check
 * @returns True if this is a completion event
 */
export function isCompletionEvent(event) {
    return (event.type === 'done' ||
        event.type === 'response.done' ||
        event.type === 'response.completed');
}
/**
 * Check if an event contains content data
 * @param event - SSE event to check
 * @returns True if this event has content
 */
export function hasContent(event) {
    if (!event.data || typeof event.data !== 'object') {
        return false;
    }
    // Check various content field patterns with proper type guards
    const payload = event.data;
    return !!(payload.delta ||
        payload.text ||
        payload.output_text ||
        (payload.message && typeof payload.message === 'object' && payload.message.content) ||
        (Array.isArray(payload.choices) && payload.choices.length > 0 &&
            typeof payload.choices[0] === 'object' &&
            payload.choices[0].delta &&
            typeof payload.choices[0].delta === 'object' &&
            payload.choices[0].delta.content));
}
//# sourceMappingURL=sse-parser.js.map