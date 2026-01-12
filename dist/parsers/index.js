import * as path from 'path';
import { parseRust, supportsExtension as rustSupports } from './rust.js';
/**
 * Supported file extensions and their parsers
 */
const SUPPORTED_EXTENSIONS = new Set(['.rs']);
/**
 * Check if a file extension is supported for summarization
 */
export function isSupported(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
}
/**
 * Get a list of supported file extensions
 */
export function getSupportedExtensions() {
    return Array.from(SUPPORTED_EXTENSIONS);
}
/**
 * Parse a file and generate a summary
 * Returns null if the file type is not supported
 */
export function parseFile(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();
    if (rustSupports(ext)) {
        return parseRust(content);
    }
    // Unsupported file type
    return null;
}
/**
 * Format a file path header for inclusion in context
 * This helps identify the file when it appears in the context window
 */
export function formatFileHeader(relativePath, isSummary) {
    const tag = isSummary ? 'SUMMARY' : 'FULL';
    return `// === ${relativePath} [${tag}] ===`;
}
//# sourceMappingURL=index.js.map