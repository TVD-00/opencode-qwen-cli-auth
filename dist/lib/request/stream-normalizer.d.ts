/**
 * Stream normalization for converting various SSE formats to OpenAI-compatible streams
 */
/**
 * Normalize Qwen Portal API SSE stream into OpenAI Chat Completions chunk stream
 *
 * This function handles multiple response formats:
 * - Cumulative deltas (each chunk contains all previous text)
 * - Incremental deltas (each chunk contains only new text)
 * - Various payload structures (Qwen, OpenAI, etc.)
 *
 * If the format is not recognized, it passes through the original stream unchanged.
 *
 * @param response - Original SSE response
 * @returns Normalized response with OpenAI-compatible chunks
 */
export declare function normalizeSseToOpenAI(response: Response): Promise<Response>;
//# sourceMappingURL=stream-normalizer.d.ts.map