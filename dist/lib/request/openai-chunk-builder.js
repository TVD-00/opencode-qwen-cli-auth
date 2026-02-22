/**
 * OpenAI Chat Completions chunk builder
 * Creates properly formatted OpenAI-style streaming chunks
 */
/**
 * Builder class for creating OpenAI-compatible streaming chunks
 */
export class OpenAIChunkBuilder {
    chunkId;
    model;
    sentInitialRole = false;
    /**
     * Create a new chunk builder
     * @param model - Model name to include in chunks
     */
    constructor(model = 'coder-model') {
        this.chunkId = `chatcmpl_${Math.random().toString(36).slice(2, 12)}`;
        this.model = model;
    }
    /**
     * Create a chunk with role information (first chunk only)
     * @returns OpenAI chunk with role
     */
    createRoleChunk() {
        this.sentInitialRole = true;
        return {
            id: this.chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [
                {
                    index: 0,
                    delta: { role: 'assistant' },
                    finish_reason: null,
                },
            ],
        };
    }
    /**
     * Create a chunk with content delta
     * @param content - Text content to include
     * @returns OpenAI chunk with content
     */
    createContentChunk(content) {
        const chunk = {
            id: this.chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [
                {
                    index: 0,
                    delta: {},
                    finish_reason: null,
                },
            ],
        };
        // Include role in first content chunk if not sent separately
        if (!this.sentInitialRole) {
            chunk.choices[0].delta.role = 'assistant';
            this.sentInitialRole = true;
        }
        chunk.choices[0].delta.content = content;
        return chunk;
    }
    /**
     * Create a finish chunk with completion reason
     * @param reason - Finish reason (e.g., 'stop', 'length')
     * @returns OpenAI chunk with finish reason
     */
    createFinishChunk(reason = 'stop') {
        return {
            id: this.chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [
                {
                    index: 0,
                    delta: {},
                    finish_reason: reason,
                },
            ],
        };
    }
    /**
     * Format a chunk as SSE data line
     * @param chunk - OpenAI chunk to format
     * @returns Formatted SSE line
     */
    formatAsSSE(chunk) {
        return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    /**
     * Create the [DONE] marker
     * @returns Formatted [DONE] SSE line
     */
    createDoneMarker() {
        return 'data: [DONE]\n\n';
    }
    /**
     * Check if initial role has been sent
     * @returns True if role chunk was already created
     */
    hasRole() {
        return this.sentInitialRole;
    }
}
//# sourceMappingURL=openai-chunk-builder.js.map