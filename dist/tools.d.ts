/**
 * Read a file and mark it as active.
 * For supported languages, auto-summarizes the previous active file.
 * For unsupported languages, returns full contents without tracking.
 */
export declare function readFile(filePath: string): Promise<string>;
/**
 * Peek at a file's summary without changing the active file.
 * For unsupported languages, returns full contents.
 */
export declare function peekFile(filePath: string): Promise<string>;
/**
 * Edit a file using string replacement.
 * Keeps the file as active and updates the cached summary.
 */
export declare function editFile(filePath: string, oldString: string, newString: string): Promise<string>;
/**
 * Write a new file.
 * Marks the file as active if it's a supported language.
 */
export declare function writeFile(filePath: string, content: string): Promise<string>;
/**
 * Get the status of all tracked files.
 */
export declare function fileStatus(): Promise<string>;
/**
 * Forget a file (remove it from tracking).
 */
export declare function forgetFile(filePath: string): Promise<string>;
//# sourceMappingURL=tools.d.ts.map