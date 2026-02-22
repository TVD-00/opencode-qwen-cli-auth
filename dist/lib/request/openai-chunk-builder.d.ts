/**
 * OpenAI Chat Completions chunk builder
 * Creates properly formatted OpenAI-style streaming chunks
 */
/**
 * OpenAI chat completion chunk structure
 */
export interface OpenAIChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: 'assistant';
            content?: string;
        };
        finish_reason: string | null;
    }>;
}
/**
 * Builder class for creating OpenAI-compatible streaming chunks
 */
export declare class OpenAIChunkBuilder {
    private chunkId;
    private model;
    private sentInitialRole;
    /**
     * Create a new chunk builder
     * @param model - Model name to include in chunks
     */
    constructor(model?: string);
    /**
     * Create a chunk with role information (first chunk only)
     * @returns OpenAI chunk with role
     */
    createRoleChunk(): OpenAIChunk;
    /**
     * Create a chunk with content delta
     * @param content - Text content to include
     * @returns OpenAI chunk with content
     */
    createContentChunk(content: string): OpenAIChunk;
    /**
     * Create a finish chunk with completion reason
     * @param reason - Finish reason (e.g., 'stop', 'length')
     * @returns OpenAI chunk with finish reason
     */
    createFinishChunk(reason?: string): OpenAIChunk;
    /**
     * Format a chunk as SSE data line
     * @param chunk - OpenAI chunk to format
     * @returns Formatted SSE line
     */
    formatAsSSE(chunk: OpenAIChunk): string;
    /**
     * Create the [DONE] marker
     * @returns Formatted [DONE] SSE line
     */
    createDoneMarker(): string;
    /**
     * Check if initial role has been sent
     * @returns True if role chunk was already created
     */
    hasRole(): boolean;
}
//# sourceMappingURL=openai-chunk-builder.d.ts.map