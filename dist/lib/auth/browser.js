/**
 * Browser utilities for OAuth flow
 * Handles platform-specific browser opening
 */
import { spawn } from "node:child_process";
import { PLATFORM_OPENERS } from "../constants.js";
/**
 * Gets the platform-specific command to open a URL in the default browser
 * @returns Browser opener command for the current platform
 */
export function getBrowserOpener() {
    const platform = process.platform;
    if (platform === "darwin")
        return PLATFORM_OPENERS.darwin;
    if (platform === "win32")
        return PLATFORM_OPENERS.win32;
    return PLATFORM_OPENERS.linux;
}
/**
 * Opens a URL in the default browser
 * Silently fails if browser cannot be opened (user can copy URL manually)
 * @param url - URL to open
 */
export function openBrowserUrl(url) {
    try {
        const opener = getBrowserOpener();
        spawn(opener, [url], {
            stdio: "ignore",
            shell: process.platform === "win32",
        });
    }
    catch (error) {
        // Log canh bao de ho tro debug, user van co the mo URL thu cong
        console.warn("[qwen-oauth-plugin] Khong the mo trinh duyet:", error?.message || error);
    }
}
//# sourceMappingURL=browser.js.map