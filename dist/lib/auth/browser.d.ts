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
 * @param url - The URL to open in browser (typically OAuth verification URL)
 */
export declare function openBrowserUrl(url: string): void;
//# sourceMappingURL=browser.d.ts.map