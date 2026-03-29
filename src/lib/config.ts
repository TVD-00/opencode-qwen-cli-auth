/**
 * @fileoverview Configuration utilities for Qwen OAuth Plugin
 * Manages paths for configuration, tokens, and cache directories
 * @license MIT
 */

import { homedir } from "os";
import { join, resolve, relative, isAbsolute, parse, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import type { PluginConfig } from "./types.js";

/**
 * Get plugin configuration directory
 * @returns Path to ~/.opencode/qwen/
 */
export function getConfigDir(): string {
    return join(homedir(), ".opencode", "qwen");
}

/**
 * Get Qwen CLI credential directory (~/.qwen)
 * This directory is shared with the official qwen-code CLI for token storage
 * @returns Path to ~/.qwen/
 */
export function getQwenDir(): string {
    return join(homedir(), ".qwen");
}

const ACCOUNTS_FILENAME = "oauth_accounts.json";
const DEFAULT_ACCOUNTS_PATH = join(getQwenDir(), ACCOUNTS_FILENAME);

function isRootPath(pathValue: string): boolean {
    const parsed = parse(pathValue);
    return pathValue === parsed.root;
}

function isPathInsideBase(pathValue: string, baseDir: string): boolean {
    const rel = relative(baseDir, pathValue);
    if (rel === "") {
        return true;
    }
    return !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveAccountsPathFromEnv(): string | null {
    const envPath = process.env.OPENCODE_QWEN_ACCOUNTS_PATH;
    if (typeof envPath !== "string" || envPath.trim().length === 0) {
        return null;
    }
    const trimmed = envPath.trim();
    if (trimmed.includes("\0")) {
        console.warn("[qwen-oauth-plugin] Ignoring OPENCODE_QWEN_ACCOUNTS_PATH with invalid null-byte");
        return null;
    }
    const resolved = resolve(trimmed);
    if (isRootPath(resolved)) {
        console.warn("[qwen-oauth-plugin] Ignoring OPENCODE_QWEN_ACCOUNTS_PATH pointing to root path");
        return null;
    }
    const baseDir = getQwenDir();
    if (!isPathInsideBase(resolved, baseDir)) {
        console.warn("[qwen-oauth-plugin] Ignoring OPENCODE_QWEN_ACCOUNTS_PATH outside ~/.qwen for safety");
        return null;
    }
    const parsed = parse(resolved);
    if (!parsed.base || parsed.base.length === 0) {
        console.warn("[qwen-oauth-plugin] Ignoring OPENCODE_QWEN_ACCOUNTS_PATH without filename");
        return null;
    }
    return resolved;
}

/**
 * Get plugin configuration file path
 * @returns Path to ~/.opencode/qwen/auth-config.json
 */
export function getConfigPath(): string {
    return join(getConfigDir(), "auth-config.json");
}

/**
 * Load plugin configuration from ~/.opencode/qwen/auth-config.json
 * Returns default config if file doesn't exist
 * @returns Configuration object with qwenMode flag
 */
export function loadPluginConfig(): PluginConfig {
    const configPath = getConfigPath();
    // Return default config if config file doesn't exist
    if (!existsSync(configPath)) {
        return { qwenMode: true }; // Default: QWEN_MODE enabled
    }
    try {
        const content = readFileSync(configPath, "utf-8");
        return JSON.parse(content) as PluginConfig;
    } catch (error) {
        // Log warning and return default config on parse error
        console.warn(`[qwen-oauth-plugin] Failed to load config from ${configPath}:`, error);
        return { qwenMode: true };
    }
}

/**
 * Get QWEN_MODE setting
 * Priority: QWEN_MODE env var > config file > default (true)
 * @param config - Configuration object from file
 * @returns True if QWEN_MODE is enabled, false otherwise
 */
export function getQwenMode(config: PluginConfig): boolean {
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
        return val === "1" || (val as string).toLowerCase() === "true";
    }
    // Convert to boolean for actual boolean values
    return !!val;
}

/**
 * Get token storage path
 * Token file contains OAuth credentials: access_token, refresh_token, expiry_date, resource_url
 * @returns Path to ~/.qwen/oauth_creds.json
 */
export function getTokenPath(): string {
    return join(getQwenDir(), "oauth_creds.json");
}

/**
 * Get token lock path for multi-process refresh coordination
 * Prevents concurrent token refresh operations across multiple processes
 * @returns Path to ~/.qwen/oauth_creds.lock
 */
export function getTokenLockPath(): string {
    return join(getQwenDir(), "oauth_creds.lock");
}

/**
 * Get multi-account storage path
 * @returns Path to ~/.qwen/oauth_accounts.json or OPENCODE_QWEN_ACCOUNTS_PATH override
 */
export function getAccountsPath(): string {
    return resolveAccountsPathFromEnv() || DEFAULT_ACCOUNTS_PATH;
}

/**
 * Get multi-account lock path
 * @returns Path to ~/.qwen/oauth_accounts.lock (or sidecar lock for override path)
 */
export function getAccountsLockPath(): string {
    const accountsPath = getAccountsPath();
    if (dirname(accountsPath) !== getQwenDir()) {
        return `${accountsPath}.lock`;
    }
    return join(getQwenDir(), "oauth_accounts.lock");
}

/**
 * Get legacy token storage path used by old plugin versions
 * Used for backward compatibility and token migration
 * @returns Path to ~/.opencode/qwen/oauth_token.json
 */
export function getLegacyTokenPath(): string {
    return join(getConfigDir(), "oauth_token.json");
}

/**
 * Get cache directory for prompts
 * @returns Path to ~/.opencode/cache/
 */
export function getCacheDir(): string {
    return join(homedir(), ".opencode", "cache");
}
