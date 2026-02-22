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
export declare function extractText(payload: unknown): string | undefined;
/**
 * Determine if the current text is cumulative (contains all previous text)
 * or incremental (only new text)
 *
 * @param current - Current text from payload
 * @param previous - Previously accumulated text
 * @returns True if current text is cumulative (starts with previous text)
 */
export declare function isCumulative(current: string, previous: string): boolean;
/**
 * Calculate the delta (new text) from current and previous text
 * Handles both cumulative and incremental formats
 *
 * @param current - Current text from payload
 * @param previous - Previously accumulated text
 * @returns Object with new text delta and updated cumulative text
 */
export declare function calculateDelta(current: string, previous: string): {
    delta: string;
    cumulative: string;
};
//# sourceMappingURL=payload-analyzer.d.ts.map