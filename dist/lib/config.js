import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
/**
 * Get plugin configuration directory
 */
export function getConfigDir() {
    return join(homedir(), ".opencode", "qwen");
}
/**
 * Get plugin configuration file path
 */
export function getConfigPath() {
    return join(getConfigDir(), "auth-config.json");
}
/**
 * Load plugin configuration from ~/.opencode/qwen/auth-config.json
 * Returns default config if file doesn't exist
 */
export function loadPluginConfig() {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
        return { qwenMode: true }; // Default to QWEN_MODE enabled
    }
    try {
        const content = readFileSync(configPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        console.warn(`[qwen-oauth-plugin] Failed to load config from ${configPath}:`, error);
        return { qwenMode: true };
    }
}
/**
 * Get QWEN_MODE setting
 * Priority: QWEN_MODE env var > config file > default (true)
 */
export function getQwenMode(config) {
    const envValue = process.env.QWEN_MODE;
    if (envValue !== undefined) {
        return envValue === "1" || envValue.toLowerCase() === "true";
    }
    // Ep kieu boolean chac chan, tranh string "false" bi truthy
    const val = config.qwenMode;
    if (val === undefined || val === null) return true; // mac dinh bat
    if (typeof val === "string") {
        return val === "1" || val.toLowerCase() === "true";
    }
    return !!val;
}
/**
 * Get token storage path
 */
export function getTokenPath() {
    return join(getConfigDir(), "oauth_token.json");
}
/**
 * Get cache directory for prompts
 */
export function getCacheDir() {
    return join(homedir(), ".opencode", "cache");
}
//# sourceMappingURL=config.js.map