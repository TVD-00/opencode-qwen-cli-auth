/**
 * Stream normalization for converting various SSE formats to OpenAI-compatible streams
 */
import { parseFrame, isCompletionEvent } from './sse-parser.js';
import { extractText, calculateDelta } from './payload-analyzer.js';
import { OpenAIChunkBuilder } from './openai-chunk-builder.js';
import { STREAM_CONFIG } from '../constants.js';
import { logWarn } from '../logger.js';
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
export async function normalizeSseToOpenAI(response) {
    if (!response.body) {
        throw new Error('[qwen-oauth-plugin] Response has no body');
    }
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const state = {
        buffer: '',
        cumulativeText: '',
        recognized: false,
        finished: false,
        rawSseOut: '',
    };
    const builder = new OpenAIChunkBuilder('coder-model');
    // Create a transformed stream
    const stream = new ReadableStream({
        async pull(controller) {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                state.buffer += decoder.decode(value, { stream: true });
                // Process complete SSE events (separated by double newlines)
                let idx;
                while ((idx = state.buffer.indexOf('\n\n')) !== -1) {
                    const frame = state.buffer.slice(0, idx);
                    state.buffer = state.buffer.slice(idx + 2);
                    const events = parseFrame(frame);
                    for (const event of events) {
                        // Handle completion events
                        if (isCompletionEvent(event)) {
                            if (!state.recognized) {
                                // Pass-through mode: emit raw data and [DONE]
                                state.rawSseOut += `data: ${event.rawData}\n\n`;
                                state.rawSseOut += builder.createDoneMarker();
                                controller.enqueue(encoder.encode(state.rawSseOut));
                            }
                            else {
                                // Normalized mode: emit finish chunk and [DONE]
                                const finishChunk = builder.createFinishChunk('stop');
                                controller.enqueue(encoder.encode(builder.formatAsSSE(finishChunk)));
                                controller.enqueue(encoder.encode(builder.createDoneMarker()));
                            }
                            state.finished = true;
                            return;
                        }
                        // Handle [DONE] marker
                        if (event.type === 'done') {
                            if (!state.recognized) {
                                state.rawSseOut += builder.createDoneMarker();
                                controller.enqueue(encoder.encode(state.rawSseOut));
                            }
                            else {
                                controller.enqueue(encoder.encode(builder.createDoneMarker()));
                            }
                            state.finished = true;
                            return;
                        }
                        // Try to extract content
                        const incomingText = extractText(event.data);
                        if (incomingText != null) {
                            // Switch to normalized mode on first recognized content
                            if (!state.recognized) {
                                state.recognized = true;
                            }
                            // Calculate delta (handles both cumulative and incremental)
                            const { delta, cumulative } = calculateDelta(incomingText, state.cumulativeText);
                            state.cumulativeText = cumulative;
                            // Emit content chunk if there's new text
                            if (delta) {
                                const chunk = builder.createContentChunk(delta);
                                controller.enqueue(encoder.encode(builder.formatAsSSE(chunk)));
                            }
                        }
                        else {
                            // Unknown payload; keep for pass-through until we recognize format
                            if (!state.recognized) {
                                state.rawSseOut += `data: ${event.rawData}\n\n`;
                                // Prevent memory leak: flush buffer if it exceeds maximum size
                                if (state.rawSseOut.length > STREAM_CONFIG.MAX_BUFFER_SIZE) {
                                    logWarn('SSE buffer exceeded maximum size, flushing to prevent memory leak');
                                    controller.enqueue(encoder.encode(state.rawSseOut));
                                    state.rawSseOut = '';
                                }
                            }
                        }
                    }
                }
            }
            // If we exit read loop without finishing
            if (!state.finished) {
                if (state.recognized) {
                    // Normalized mode: emit finish chunk and [DONE]
                    const finishChunk = builder.createFinishChunk('stop');
                    controller.enqueue(encoder.encode(builder.formatAsSSE(finishChunk)));
                    controller.enqueue(encoder.encode(builder.createDoneMarker()));
                }
                else {
                    // Pass-through mode: emit whatever we buffered verbatim
                    controller.enqueue(encoder.encode(state.rawSseOut));
                }
            }
            controller.close();
        },
        cancel() {
            reader.cancel();
        },
    });
    // Preserve headers but ensure SSE content type
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
//# sourceMappingURL=stream-normalizer.js.map