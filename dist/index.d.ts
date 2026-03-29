/**
 * @fileoverview Alibaba Qwen OAuth Authentication Plugin for opencode
 * Main plugin entry point implementing OAuth 2.0 Device Authorization Grant
 * Handles authentication, request transformation, and error recovery
 *
 * Architecture:
 * - OAuth flow: PKCE + Device Code Grant (RFC 8628)
 * - Token management: Automatic refresh with file-based storage
 * - Request handling: Custom fetch wrapper with retry logic
 * - Error recovery: Quota degradation and CLI fallback
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @repository https://github.com/TVD-00/opencode-qwen-cli-auth
 * @version 2.4.0
 */
import type { Plugin } from "@opencode-ai/plugin";
/**
 * Alibaba Qwen OAuth authentication plugin for opencode
 * Integrates Qwen OAuth device flow and API handling into opencode SDK
 *
 * @param {*} _input - Plugin initialization input
 * @returns {Promise<Object>} Plugin configuration and hooks
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-alibaba-qwen-cli-auth"],
 *   "model": "qwen-code/coder-model"
 * }
 * ```
 */
export declare const QwenAuthPlugin: Plugin;
export default QwenAuthPlugin;
//# sourceMappingURL=index.d.ts.map