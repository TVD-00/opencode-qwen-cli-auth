/**
 * Header manipulation utilities
 * Provides functions for normalizing, merging, and cleaning HTTP headers
 */
import type { HeadersInput } from "../types.js";
/**
 * Normalize various header types to a plain object
 * @param headers - Headers in any valid format (Headers object, array, or plain object)
 * @returns Plain object with header key-value pairs
 */
export declare function normalizeHeaders(headers: HeadersInput | undefined): Record<string, string>;
/**
 * Remove specific headers from a header object (case-insensitive)
 * @param headers - Header object
 * @param toRemove - Array of header names to remove (case-insensitive)
 * @returns New header object with specified headers removed
 */
export declare function removeHeaders(headers: Record<string, string>, toRemove: string[]): Record<string, string>;
/**
 * Merge headers, optionally removing conflicting headers first
 * This ensures clean header merging without duplicates or stale values
 *
 * @param existing - Existing headers in any format
 * @param additional - Additional headers to merge in
 * @param overwrite - Header names to remove from existing before merging (case-insensitive)
 * @returns Merged header object
 *
 * @example
 * ```typescript
 * const merged = mergeHeaders(
 *   existingHeaders,
 *   { 'Authorization': 'Bearer new-token' },
 *   ['authorization', 'content-type'] // Remove old auth/content-type first
 * );
 * ```
 */
export declare function mergeHeaders(existing: HeadersInput | undefined, additional: Record<string, string>, overwrite?: string[]): Record<string, string>;
//# sourceMappingURL=header-utils.d.ts.map