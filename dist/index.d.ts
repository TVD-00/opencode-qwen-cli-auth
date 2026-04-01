/**
 * Qwen OAuth authentication plugin for OpenCode
 *
 * Architecture follows OpenCode's Copilot/Codex plugin pattern:
 * - auth.loader returns { fetch, apiKey, baseURL, timeout }
 * - Custom fetch handles DashScope headers and token refresh
 * - OpenCode handles timeout, retries, and streaming natively
 *
 * @version 3.0.0
 */
import type { Plugin } from "@opencode-ai/plugin";
export declare const QwenAuthPlugin: Plugin;
export default QwenAuthPlugin;
//# sourceMappingURL=index.d.ts.map