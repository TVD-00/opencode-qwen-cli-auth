/**
 * @fileoverview Browser utilities for OAuth flow
 * Handles platform-specific browser opening for OAuth authorization URL
 * @license MIT
 */

import { spawn } from "node:child_process";
import { PLATFORM_OPENERS } from "../constants.js";

/**
 * Gets the platform-specific command to open a URL in the default browser
 * @returns {string} Browser opener command for the current platform (darwin: 'open', win32: 'start', linux: 'xdg-open')
 */
export function getBrowserOpener() {
    const platform = process.platform;
    // macOS uses 'open' command
    if (platform === "darwin")
        return PLATFORM_OPENERS.darwin;
    // Windows uses 'start' command
    if (platform === "win32")
        return PLATFORM_OPENERS.win32;
    // Linux uses 'xdg-open' command
    return PLATFORM_OPENERS.linux;
}

/**
 * Opens a URL in the default browser
 * Silently fails if browser cannot be opened (user can copy URL manually)
 * @param {string} url - The URL to open in browser (typically OAuth verification URL)
 * @returns {void}
 */
export function openBrowserUrl(url) {
    try {
        const opener = getBrowserOpener();
        // Spawn browser process with detached stdio to avoid blocking
        spawn(opener, [url], {
            stdio: "ignore",
            // Use shell on Windows for 'start' command to work properly
            shell: process.platform === "win32",
        });
    }
    catch (error) {
        // Log warning for debugging, user can still open URL manually
        console.warn("[qwen-oauth-plugin] Unable to open browser:", error?.message || error);
    }
}
//# sourceMappingURL=browser.js.map