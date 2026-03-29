/**
 * @fileoverview Configuration utilities for Qwen OAuth Plugin
 * Manages paths for configuration, tokens, and cache directories
 * @license MIT
 */
import type { PluginConfig } from "./types.js";
/**
 * Get plugin configuration directory
 * @returns Path to ~/.opencode/qwen/
 */
export declare function getConfigDir(): string;
/**
 * Get Qwen CLI credential directory (~/.qwen)
 * This directory is shared with the official qwen-code CLI for token storage
 * @returns Path to ~/.qwen/
 */
export declare function getQwenDir(): string;
/**
 * Get plugin configuration file path
 * @returns Path to ~/.opencode/qwen/auth-config.json
 */
export declare function getConfigPath(): string;
/**
 * Load plugin configuration from ~/.opencode/qwen/auth-config.json
 * Returns default config if file doesn't exist
 * @returns Configuration object with qwenMode flag
 */
export declare function loadPluginConfig(): PluginConfig;
/**
 * Get QWEN_MODE setting
 * Priority: QWEN_MODE env var > config file > default (true)
 * @param config - Configuration object from file
 * @returns True if QWEN_MODE is enabled, false otherwise
 */
export declare function getQwenMode(config: PluginConfig): boolean;
/**
 * Get token storage path
 * Token file contains OAuth credentials: access_token, refresh_token, expiry_date, resource_url
 * @returns Path to ~/.qwen/oauth_creds.json
 */
export declare function getTokenPath(): string;
/**
 * Get token lock path for multi-process refresh coordination
 * Prevents concurrent token refresh operations across multiple processes
 * @returns Path to ~/.qwen/oauth_creds.lock
 */
export declare function getTokenLockPath(): string;
/**
 * Get multi-account storage path
 * @returns Path to ~/.qwen/oauth_accounts.json or OPENCODE_QWEN_ACCOUNTS_PATH override
 */
export declare function getAccountsPath(): string;
/**
 * Get multi-account lock path
 * @returns Path to ~/.qwen/oauth_accounts.lock (or sidecar lock for override path)
 */
export declare function getAccountsLockPath(): string;
/**
 * Get legacy token storage path used by old plugin versions
 * Used for backward compatibility and token migration
 * @returns Path to ~/.opencode/qwen/oauth_token.json
 */
export declare function getLegacyTokenPath(): string;
/**
 * Get cache directory for prompts
 * @returns Path to ~/.opencode/cache/
 */
export declare function getCacheDir(): string;
//# sourceMappingURL=config.d.ts.map