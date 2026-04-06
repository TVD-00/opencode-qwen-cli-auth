/**
 * @fileoverview Browser utilities for OAuth flow
 * Handles platform-specific browser opening for OAuth authorization URL
 * @license MIT
 */
import { spawn } from "node:child_process";
import { PLATFORM_OPENERS } from "../constants.js";
/**
 * Gets the platform-specific command to open a URL in the default browser
 * @returns Browser opener command for the current platform (darwin: 'open', win32: 'start', linux: 'xdg-open')
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
 *
 * Windows-specific: URLs containing `&` (e.g. `?user_code=X&client=qwen-code`)
 * must be quoted because `cmd.exe /c start` treats `&` as a command separator.
 * Without quotes, only the portion before the first `&` is opened, causing
 * "user_code or client is null" errors on the Qwen OAuth page.
 *
 * @param url - The URL to open in browser (typically OAuth verification URL)
 */
export function openBrowserUrl(url) {
    try {
        if (process.platform === "win32") {
            // On Windows, `cmd /c start "" "url"` is required:
            //  - First "" is the window title (required by start command)
            //  - Second quoted url prevents & from being parsed as cmd separator
            spawn("cmd", ["/c", "start", "", `"${url}"`], {
                stdio: "ignore",
                shell: false,
            });
        }
        else {
            const opener = getBrowserOpener();
            spawn(opener, [url], {
                stdio: "ignore",
            });
        }
    }
    catch (error) {
        // Log warning for debugging, user can still open URL manually
        console.warn("[qwen-oauth-plugin] Unable to open browser:", error?.message || error);
    }
}
//# sourceMappingURL=browser.js.map