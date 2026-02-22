import type { RequestBody, ChatMessage } from "../types.js";
/**
 * Normalize Qwen model names for Portal API (OAuth)
 *
 * Portal API uses a single 'coder-model' for all coding tasks.
 * This function provides backward compatibility for legacy model names.
 *
 * @param model - Model name from config (e.g., "alibaba/coder-model" or legacy names)
 * @returns Normalized model name for Portal API ("coder-model")
 */
export declare function normalizeModel(model: string): string;
/**
 * Filter OpenCode qwen.txt system prompts from messages
 * @param messages - Input messages
 * @param openCodeQwenPrompt - OpenCode qwen.txt content for verification
 * @returns Filtered messages
 */
export declare function filterOpenCodeQwenPrompts(messages: ChatMessage[], openCodeQwenPrompt: string): ChatMessage[];
/**
 * Add Qwen-OpenCode bridge message
 * @param messages - Input messages
 * @returns Messages with bridge prompt added
 */
export declare function addQwenBridgeMessage(messages: ChatMessage[]): ChatMessage[];
/**
 * Add tool remap message for QWEN_MODE=false
 * @param messages - Input messages
 * @returns Messages with remap message added
 */
export declare function addQwenToolRemapMessage(messages: ChatMessage[]): ChatMessage[];
/**
 * Transform request body for Qwen Portal API (OAuth)
 * @param body - Original request body
 * @param qwenMode - QWEN_MODE setting
 * @param openCodeQwenPrompt - OpenCode qwen.txt content (for filtering)
 * @returns Transformed request body
 */
export declare function transformRequestBody(body: RequestBody, qwenMode: boolean, openCodeQwenPrompt: string): RequestBody;
//# sourceMappingURL=request-transformer.d.ts.map