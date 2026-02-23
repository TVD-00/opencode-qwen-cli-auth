import type { PluginConfig } from "./types.js";
/**
 * Get plugin configuration directory
 */
export declare function getConfigDir(): string;
/**
 * Get Qwen CLI credential directory (~/.qwen)
 */
export declare function getQwenDir(): string;
/**
 * Get plugin configuration file path
 */
export declare function getConfigPath(): string;
/**
 * Load plugin configuration from ~/.opencode/qwen/auth-config.json
 * Returns default config if file doesn't exist
 */
export declare function loadPluginConfig(): PluginConfig;
/**
 * Get QWEN_MODE setting
 * Priority: QWEN_MODE env var > config file > default (true)
 */
export declare function getQwenMode(config: PluginConfig): boolean;
/**
 * Get token storage path
 */
export declare function getTokenPath(): string;
/**
 * Get token lock path for multi-process refresh coordination
 */
export declare function getTokenLockPath(): string;
/**
 * Get legacy token storage path used by old plugin versions
 */
export declare function getLegacyTokenPath(): string;
/**
 * Get cache directory for prompts
 */
export declare function getCacheDir(): string;
//# sourceMappingURL=config.d.ts.map
