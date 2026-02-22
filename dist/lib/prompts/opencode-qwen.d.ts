/**
 * Fetch OpenCode qwen.txt prompt from GitHub with ETag caching
 * @returns OpenCode qwen.txt content
 */
export declare function getOpenCodeQwenPrompt(): Promise<string>;
/**
 * Check if message content matches OpenCode qwen.txt prompt
 * Used for filtering in QWEN_MODE
 * @param content - Message content to check
 * @param qwenPrompt - OpenCode qwen.txt content
 * @returns True if content matches OpenCode prompt
 */
export declare function isOpenCodeQwenPrompt(content: string, qwenPrompt: string): boolean;
//# sourceMappingURL=opencode-qwen.d.ts.map