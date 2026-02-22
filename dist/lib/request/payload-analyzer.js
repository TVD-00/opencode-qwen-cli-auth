/**
 * Payload analysis utilities
 * Extracts and analyzes content from various API response formats
 */
/**
 * Extract text content from a payload with various possible structures
 * Handles multiple API response formats (OpenAI, Qwen, etc.)
 *
 * @param payload - Response payload to analyze
 * @returns Extracted text content, or undefined if not found
 */
export function extractText(payload) {
    if (!payload || typeof payload !== 'object')
        return undefined;
    // Type guard to ensure payload is an object
    const obj = payload;
    // Common direct string fields
    if (typeof obj.delta === 'string')
        return obj.delta;
    if (typeof obj.text === 'string')
        return obj.text;
    if (typeof obj.output_text === 'string')
        return obj.output_text;
    // Nested checks with proper type guards
    if (obj.response && typeof obj.response === 'object') {
        const response = obj.response;
        if (typeof response.output_text === 'string')
            return response.output_text;
    }
    if (obj.message && typeof obj.message === 'object') {
        const message = obj.message;
        if (typeof message.content === 'string')
            return message.content;
    }
    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
        const choice = obj.choices[0];
        if (choice.delta && typeof choice.delta === 'object') {
            const delta = choice.delta;
            if (typeof delta.content === 'string')
                return delta.content;
        }
    }
    // Nested under delta
    if (obj.delta && typeof obj.delta === 'object') {
        const delta = obj.delta;
        if (typeof delta.text === 'string')
            return delta.text;
        if (typeof delta.content === 'string')
            return delta.content;
    }
    // Array-shaped content collectors
    const candidates = [
        obj.message && typeof obj.message === 'object' ? obj.message.content : undefined,
        obj.delta && typeof obj.delta === 'object' ? obj.delta.content : undefined,
        obj.content
    ];
    for (const c of candidates) {
        if (Array.isArray(c)) {
            let combined = '';
            for (const item of c) {
                if (typeof item === 'string') {
                    combined += item;
                }
                else if (item && typeof item === 'object') {
                    const itemObj = item;
                    if (typeof itemObj.text === 'string')
                        combined += itemObj.text;
                    else if (typeof itemObj.content === 'string')
                        combined += itemObj.content;
                }
            }
            if (combined)
                return combined;
        }
    }
    return undefined;
}
/**
 * Determine if the current text is cumulative (contains all previous text)
 * or incremental (only new text)
 *
 * @param current - Current text from payload
 * @param previous - Previously accumulated text
 * @returns True if current text is cumulative (starts with previous text)
 */
export function isCumulative(current, previous) {
    if (!previous)
        return false;
    return current.startsWith(previous);
}
/**
 * Calculate the delta (new text) from current and previous text
 * Handles both cumulative and incremental formats
 *
 * @param current - Current text from payload
 * @param previous - Previously accumulated text
 * @returns Object with new text delta and updated cumulative text
 */
export function calculateDelta(current, previous) {
    if (!previous) {
        // First chunk
        return { delta: current, cumulative: current };
    }
    if (isCumulative(current, previous)) {
        // Cumulative style: extract only the new part
        const delta = current.slice(previous.length);
        return { delta, cumulative: current };
    }
    else {
        // Incremental style: current is already just the delta
        return { delta: current, cumulative: previous + current };
    }
}
//# sourceMappingURL=payload-analyzer.js.map