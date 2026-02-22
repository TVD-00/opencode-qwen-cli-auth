export { normalizeSseToOpenAI } from './stream-normalizer.js';
/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @returns Response with JSON body
 */
export declare function convertSseToJson(response: Response, headers: Headers): Promise<Response>;
/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export declare function ensureContentType(headers: Headers): Headers;
//# sourceMappingURL=response-handler.d.ts.map