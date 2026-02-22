/**
 * Browser utilities for OAuth flow
 * Handles platform-specific browser opening
 */
/**
 * Gets the platform-specific command to open a URL in the default browser
 * @returns Browser opener command for the current platform
 */
export declare function getBrowserOpener(): string;
/**
 * Opens a URL in the default browser
 * Silently fails if browser cannot be opened (user can copy URL manually)
 * @param url - URL to open
 */
export declare function openBrowserUrl(url: string): void;
//# sourceMappingURL=browser.d.ts.map