import { ParseOutcome } from './types.js';
export { ParseOutcome, ParseResult, ParseError } from './types.js';
export type { FileSummary } from './types.js';
/**
 * Check if a file extension is supported for summarization
 */
export declare function isSupported(filePath: string): boolean;
/**
 * Get a list of supported file extensions
 */
export declare function getSupportedExtensions(): string[];
/**
 * Parse a file and generate a summary
 * Returns null if the file type is not supported
 */
export declare function parseFile(filePath: string, content: string): ParseOutcome | null;
/**
 * Format a file path header for inclusion in context
 * This helps identify the file when it appears in the context window
 */
export declare function formatFileHeader(relativePath: string, isSummary: boolean): string;
//# sourceMappingURL=index.d.ts.map