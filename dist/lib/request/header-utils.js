/**
 * Header manipulation utilities
 * Provides functions for normalizing, merging, and cleaning HTTP headers
 */
/**
 * Normalize various header types to a plain object
 * @param headers - Headers in any valid format (Headers object, array, or plain object)
 * @returns Plain object with header key-value pairs
 */
export function normalizeHeaders(headers) {
    if (!headers)
        return {};
    if (headers instanceof Headers) {
        const result = {};
        headers.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }
    if (Array.isArray(headers)) {
        const result = {};
        for (const [key, value] of headers) {
            result[key] = value;
        }
        return result;
    }
    // headers is now a plain object - filter out undefined values
    const result = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}
/**
 * Remove specific headers from a header object (case-insensitive)
 * @param headers - Header object
 * @param toRemove - Array of header names to remove (case-insensitive)
 * @returns New header object with specified headers removed
 */
export function removeHeaders(headers, toRemove) {
    const result = { ...headers };
    const lowerToRemove = toRemove.map(h => h.toLowerCase());
    for (const key of Object.keys(result)) {
        if (lowerToRemove.includes(key.toLowerCase())) {
            delete result[key];
        }
    }
    return result;
}
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
export function mergeHeaders(existing, additional, overwrite = []) {
    const normalized = normalizeHeaders(existing);
    const cleaned = removeHeaders(normalized, overwrite);
    return { ...cleaned, ...additional };
}
//# sourceMappingURL=header-utils.js.map