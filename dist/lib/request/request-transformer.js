import { getQwenCodePrompt } from "../prompts/qwen-code.js";
import { QWEN_OPENCODE_BRIDGE, QWEN_TOOL_REMAP_MESSAGE } from "../prompts/qwen-opencode-bridge.js";
import { isOpenCodeQwenPrompt } from "../prompts/opencode-qwen.js";
/**
 * Normalize Qwen model names for Portal API (OAuth)
 *
 * Portal API uses a single 'coder-model' for all coding tasks.
 * This function provides backward compatibility for legacy model names.
 *
 * @param model - Model name from config (e.g., "alibaba/coder-model" or legacy names)
 * @returns Normalized model name for Portal API ("coder-model")
 */
export function normalizeModel(model) {
    // Remove provider prefix if present (alibaba/coder-model → coder-model)
    const modelName = model.includes("/") ? model.split("/")[1] : model;
    // Portal API uses 'coder-model' for all coding tasks
    // Accept legacy model names for backward compatibility
    if (modelName.startsWith("qwen3-coder") ||
        modelName.startsWith("qwen-coder") ||
        modelName.startsWith("qwen-turbo") ||
        modelName.startsWith("qwen-max") ||
        modelName.startsWith("qwen-plus") ||
        modelName === "coder-model") {
        return "coder-model";
    }
    // Vision model (not applicable for OpenCode, but included for completeness)
    if (modelName.includes("vision") || modelName.includes("vl")) {
        return "vision-model";
    }
    // Default to coder-model for any unrecognized model name
    return "coder-model";
}
/**
 * Filter OpenCode qwen.txt system prompts from messages
 * @param messages - Input messages
 * @param openCodeQwenPrompt - OpenCode qwen.txt content for verification
 * @returns Filtered messages
 */
export function filterOpenCodeQwenPrompts(messages, openCodeQwenPrompt) {
    return messages.filter(msg => {
        if (msg.role !== "system") {
            return true;
        }
        return !isOpenCodeQwenPrompt(msg.content, openCodeQwenPrompt);
    });
}
/**
 * Add Qwen-OpenCode bridge message
 * @param messages - Input messages
 * @returns Messages with bridge prompt added
 */
export function addQwenBridgeMessage(messages) {
    return [
        { role: "system", content: QWEN_OPENCODE_BRIDGE },
        ...messages,
    ];
}
/**
 * Add tool remap message for QWEN_MODE=false
 * @param messages - Input messages
 * @returns Messages with remap message added
 */
export function addQwenToolRemapMessage(messages) {
    return [
        { role: "system", content: QWEN_TOOL_REMAP_MESSAGE },
        ...messages,
    ];
}
/**
 * Transform request body for Qwen Portal API (OAuth)
 * @param body - Original request body
 * @param qwenMode - QWEN_MODE setting
 * @param openCodeQwenPrompt - OpenCode qwen.txt content (for filtering)
 * @returns Transformed request body
 */
export function transformRequestBody(body, qwenMode, openCodeQwenPrompt) {
    const transformed = { ...body };
    // Normalize model name for Portal API
    if (transformed.model) {
        transformed.model = normalizeModel(transformed.model);
    }
    // Transform messages array
    if (transformed.messages && Array.isArray(transformed.messages)) {
        if (qwenMode) {
            // Filter OpenCode qwen.txt system prompts
            transformed.messages = filterOpenCodeQwenPrompts(transformed.messages, openCodeQwenPrompt);
            // Add Qwen Code system prompt
            const qwenCodePrompt = getQwenCodePrompt();
            transformed.messages = [
                { role: "system", content: qwenCodePrompt },
                ...transformed.messages,
            ];
            // Add Qwen-OpenCode bridge prompt
            transformed.messages = addQwenBridgeMessage(transformed.messages);
        }
        else {
            // QWEN_MODE=false: Use OpenCode qwen.txt (already in messages)
            // Just add tool remap message
            transformed.messages = addQwenToolRemapMessage(transformed.messages);
        }
    }
    // Remove any Codex-specific fields
    delete transformed.instructions;
    delete transformed.reasoning_effort;
    delete transformed.reasoning_summary;
    return transformed;
}
//# sourceMappingURL=request-transformer.js.map