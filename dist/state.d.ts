export interface CachedSummary {
    /** The generated summary text */
    summary: string;
    /** Hash of full file contents (for staleness detection) */
    contentHash: string;
    /** Size of full file in bytes */
    fullSize: number;
    /** Size of summary in bytes */
    summarySize: number;
    /** Timestamp of last access */
    lastAccessed: Date;
    /** Relative path from project root */
    relativePath: string;
}
export interface ContextConfig {
    /** Maximum number of files to track */
    maxTrackedFiles: number;
    /** Maximum lines for doc comments in summaries */
    maxDocLines: number;
    /** Project root directory */
    projectRoot: string;
}
export declare class ContextState {
    /** The file Claude is currently working on (full contents in context) */
    private activeFile;
    /** Cached summaries for inactive files */
    private summaries;
    /** Access order for potential LRU eviction */
    private accessOrder;
    /** Configuration */
    private config;
    constructor(config?: Partial<ContextConfig>);
    /**
     * Get the currently active file path
     */
    getActiveFile(): string | null;
    /**
     * Set a file as active, returning the previous active file (if any)
     */
    setActiveFile(filePath: string): string | null;
    /**
     * Clear the active file without setting a new one
     */
    clearActiveFile(): void;
    /**
     * Check if a file is currently active
     */
    isActive(filePath: string): boolean;
    /**
     * Get cached summary for a file
     */
    getSummary(filePath: string): CachedSummary | undefined;
    /**
     * Store a summary for a file
     */
    setSummary(filePath: string, summary: string, fullContent: string): void;
    /**
     * Check if a cached summary is stale (file has changed on disk)
     */
    isStale(filePath: string): boolean;
    /**
     * Remove a file from tracking
     */
    forget(filePath: string): boolean;
    /**
     * Get all tracked files with their status
     */
    getStatus(): {
        activeFile: string | null;
        summaries: Array<{
            path: string;
            relativePath: string;
            fullSize: number;
            summarySize: number;
            savings: number;
            lastAccessed: Date;
        }>;
        totalFullSize: number;
        totalSummarySize: number;
        totalSavings: number;
    };
    /**
     * Get relative path from project root
     */
    getRelativePath(filePath: string): string;
    /**
     * Normalize a file path to absolute form
     */
    private normalizePath;
    /**
     * Hash file contents for staleness detection
     */
    private hashContent;
    /**
     * Update access order for LRU tracking
     */
    private updateAccessOrder;
    /**
     * Evict least recently used files if over limit
     */
    private evictIfNeeded;
}
export declare function getContextState(config?: Partial<ContextConfig>): ContextState;
export declare function resetContextState(): void;
//# sourceMappingURL=state.d.ts.map