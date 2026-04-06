/**
 * @fileoverview Browser utilities for OAuth flow
 * Handles platform-specific browser opening for OAuth authorization URL
 * @license MIT
 */
/**
 * Gets the platform-specific command to open a URL in the default browser
 * @returns Browser opener command for the current platform (darwin: 'open', win32: 'start', linux: 'xdg-open')
 */
export declare function getBrowserOpener(): string;
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
export declare function openBrowserUrl(url: string): void;
//# sourceMappingURL=browser.d.ts.map