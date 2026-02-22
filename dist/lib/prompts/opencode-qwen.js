import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { getCacheDir } from "../config.js";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
// Get the directory of the current module for loading the fallback file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Load the bundled OpenCode qwen.txt fallback
 * This is used when GitHub is unavailable and no cache exists
 */
function loadBundledFallback() {
    const fallbackPath = join(__dirname, "fallback", "opencode-qwen-prompt.txt");
    return readFileSync(fallbackPath, "utf-8");
}
/**
 * OpenCode qwen.txt prompt URL
 */
const OPENCODE_QWEN_URL = "https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/qwen.txt";
/**
 * Cache paths
 */
const CACHE_FILE = "opencode-qwen.txt";
const META_FILE = "opencode-qwen-meta.json";
/**
 * Fetch OpenCode qwen.txt prompt from GitHub with ETag caching
 * @returns OpenCode qwen.txt content
 */
export async function getOpenCodeQwenPrompt() {
    const cacheDir = getCacheDir();
    const cachePath = join(cacheDir, CACHE_FILE);
    const metaPath = join(cacheDir, META_FILE);
    // Ensure cache directory exists
    if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    }
    // Load cached metadata
    let metadata = null;
    if (existsSync(metaPath)) {
        try {
            const content = readFileSync(metaPath, "utf-8");
            metadata = JSON.parse(content);
        }
        catch {
            // Ignore invalid metadata
        }
    }
    // Fetch with ETag
    const headers = {};
    if (metadata?.etag) {
        headers["If-None-Match"] = metadata.etag;
    }
    try {
        const res = await fetch(OPENCODE_QWEN_URL, { headers });
        // 304 Not Modified - use cache
        if (res.status === 304 && existsSync(cachePath)) {
            const cached = readFileSync(cachePath, "utf-8");
            // Update last checked time
            if (metadata) {
                metadata.lastChecked = Date.now();
                writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
            }
            return cached;
        }
        // 200 OK - update cache
        if (res.ok) {
            const content = await res.text();
            const etag = res.headers.get("etag");
            // Save content
            writeFileSync(cachePath, content, "utf-8");
            // Save metadata
            const newMetadata = {
                etag,
                lastChecked: Date.now(),
                url: OPENCODE_QWEN_URL,
            };
            writeFileSync(metaPath, JSON.stringify(newMetadata, null, 2), "utf-8");
            return content;
        }
        // Fetch failed - use cache if available
        if (existsSync(cachePath)) {
            console.warn("[qwen-oauth-plugin] Failed to fetch OpenCode qwen.txt (status: " + res.status + "), using cache");
            return readFileSync(cachePath, "utf-8");
        }
        // No cache available - use bundled fallback
        console.warn("[qwen-oauth-plugin] No cache available, using bundled fallback for OpenCode qwen.txt");
        return loadBundledFallback();
    }
    catch (error) {
        // Network error - use cache if available
        if (existsSync(cachePath)) {
            console.warn("[qwen-oauth-plugin] Network error fetching OpenCode qwen.txt, using cache");
            return readFileSync(cachePath, "utf-8");
        }
        // No cache available - use bundled fallback as last resort
        console.warn("[qwen-oauth-plugin] Network error and no cache, using bundled fallback for OpenCode qwen.txt");
        return loadBundledFallback();
    }
}
/**
 * Check if message content matches OpenCode qwen.txt prompt
 * Used for filtering in QWEN_MODE
 * @param content - Message content to check
 * @param qwenPrompt - OpenCode qwen.txt content
 * @returns True if content matches OpenCode prompt
 */
export function isOpenCodeQwenPrompt(content, qwenPrompt) {
    // Exact match
    if (content === qwenPrompt) {
        return true;
    }
    // Fuzzy match - check for signature phrases
    const signatures = [
        "You are opencode, an interactive CLI tool",
        "IMPORTANT: Refuse to write code or explain code that may be used maliciously",
        "When the user directly asks about opencode",
    ];
    return signatures.every(sig => content.includes(sig));
}
//# sourceMappingURL=opencode-qwen.js.map