/**
 * @fileoverview Configuration utilities for Qwen OAuth Plugin
 * Manages paths for configuration, tokens, and cache directories
 * @license MIT
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

/**
 * Get plugin configuration directory
 * @returns {string} Path to ~/.opencode/qwen/
 */
export function getConfigDir() {
    return join(homedir(), ".opencode", "qwen");
}

/**
 * Get Qwen CLI credential directory (~/.qwen)
 * This directory is shared with the official qwen-code CLI for token storage
 * @returns {string} Path to ~/.qwen/
 */
export function getQwenDir() {
    return join(homedir(), ".qwen");
}

/**
 * Get plugin configuration file path
 * @returns {string} Path to ~/.opencode/qwen/auth-config.json
 */
export function getConfigPath() {
    return join(getConfigDir(), "auth-config.json");
}

/**
 * Load plugin configuration from ~/.opencode/qwen/auth-config.json
 * Returns default config if file doesn't exist
 * @returns {{ qwenMode: boolean }} Configuration object with qwenMode flag
 */
export function loadPluginConfig() {
    const configPath = getConfigPath();
    // Return default config if config file doesn't exist
    if (!existsSync(configPath)) {
        return { qwenMode: true }; // Default: QWEN_MODE enabled
    }
    try {
        const content = readFileSync(configPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        // Log warning and return default config on parse error
        console.warn(`[qwen-oauth-plugin] Failed to load config from ${configPath}:`, error);
        return { qwenMode: true };
    }
}

/**
 * Get QWEN_MODE setting
 * Priority: QWEN_MODE env var > config file > default (true)
 * @param {{ qwenMode?: boolean|string|null }} config - Configuration object from file
 * @returns {boolean} True if QWEN_MODE is enabled, false otherwise
 */
export function getQwenMode(config) {
    // Environment variable takes highest priority
    const envValue = process.env.QWEN_MODE;
    if (envValue !== undefined) {
        return envValue === "1" || envValue.toLowerCase() === "true";
    }
    // Ensure boolean type, avoid string "false" being truthy
    const val = config.qwenMode;
    if (val === undefined || val === null) return true; // default: enabled
    // Handle string values from config file
    if (typeof val === "string") {
        return val === "1" || val.toLowerCase() === "true";
    }
    // Convert to boolean for actual boolean values
    return !!val;
}

/**
 * Get token storage path
 * Token file contains OAuth credentials: access_token, refresh_token, expiry_date, resource_url
 * @returns {string} Path to ~/.qwen/oauth_creds.json
 */
export function getTokenPath() {
    return join(getQwenDir(), "oauth_creds.json");
}

/**
 * Get token lock path for multi-process refresh coordination
 * Prevents concurrent token refresh operations across multiple processes
 * @returns {string} Path to ~/.qwen/oauth_creds.lock
 */
export function getTokenLockPath() {
    return join(getQwenDir(), "oauth_creds.lock");
}

/**
 * Get legacy token storage path used by old plugin versions
 * Used for backward compatibility and token migration
 * @returns {string} Path to ~/.opencode/qwen/oauth_token.json
 */
export function getLegacyTokenPath() {
    return join(getConfigDir(), "oauth_token.json");
}

/**
 * Get cache directory for prompts
 * @returns {string} Path to ~/.opencode/cache/
 */
export function getCacheDir() {
    return join(homedir(), ".opencode", "cache");
}
//# sourceMappingURL=config.js.map
