import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
export class ContextState {
    /** The file Claude is currently working on (full contents in context) */
    activeFile = null;
    /** Cached summaries for inactive files */
    summaries = new Map();
    /** Access order for potential LRU eviction */
    accessOrder = [];
    /** Configuration */
    config;
    constructor(config = {}) {
        this.config = {
            maxTrackedFiles: config.maxTrackedFiles ?? 50,
            maxDocLines: config.maxDocLines ?? 5,
            projectRoot: config.projectRoot ?? process.cwd(),
        };
    }
    /**
     * Get the currently active file path
     */
    getActiveFile() {
        return this.activeFile;
    }
    /**
     * Set a file as active, returning the previous active file (if any)
     */
    setActiveFile(filePath) {
        const previousActive = this.activeFile;
        this.activeFile = this.normalizePath(filePath);
        this.updateAccessOrder(this.activeFile);
        return previousActive;
    }
    /**
     * Clear the active file without setting a new one
     */
    clearActiveFile() {
        this.activeFile = null;
    }
    /**
     * Check if a file is currently active
     */
    isActive(filePath) {
        return this.activeFile === this.normalizePath(filePath);
    }
    /**
     * Get cached summary for a file
     */
    getSummary(filePath) {
        return this.summaries.get(this.normalizePath(filePath));
    }
    /**
     * Store a summary for a file
     */
    setSummary(filePath, summary, fullContent) {
        const normalizedPath = this.normalizePath(filePath);
        const contentHash = this.hashContent(fullContent);
        this.summaries.set(normalizedPath, {
            summary,
            contentHash,
            fullSize: Buffer.byteLength(fullContent, 'utf8'),
            summarySize: Buffer.byteLength(summary, 'utf8'),
            lastAccessed: new Date(),
            relativePath: this.getRelativePath(filePath),
        });
        this.updateAccessOrder(normalizedPath);
        this.evictIfNeeded();
    }
    /**
     * Check if a cached summary is stale (file has changed on disk)
     */
    isStale(filePath) {
        const normalizedPath = this.normalizePath(filePath);
        const cached = this.summaries.get(normalizedPath);
        if (!cached)
            return true;
        try {
            const currentContent = fs.readFileSync(filePath, 'utf8');
            const currentHash = this.hashContent(currentContent);
            return currentHash !== cached.contentHash;
        }
        catch {
            return true;
        }
    }
    /**
     * Remove a file from tracking
     */
    forget(filePath) {
        const normalizedPath = this.normalizePath(filePath);
        const deleted = this.summaries.delete(normalizedPath);
        if (this.activeFile === normalizedPath) {
            this.activeFile = null;
        }
        this.accessOrder = this.accessOrder.filter((p) => p !== normalizedPath);
        return deleted;
    }
    /**
     * Get all tracked files with their status
     */
    getStatus() {
        const summaryList = Array.from(this.summaries.entries()).map(([path, cached]) => ({
            path,
            relativePath: cached.relativePath,
            fullSize: cached.fullSize,
            summarySize: cached.summarySize,
            savings: cached.fullSize - cached.summarySize,
            lastAccessed: cached.lastAccessed,
        }));
        const totalFullSize = summaryList.reduce((sum, s) => sum + s.fullSize, 0);
        const totalSummarySize = summaryList.reduce((sum, s) => sum + s.summarySize, 0);
        return {
            activeFile: this.activeFile,
            summaries: summaryList,
            totalFullSize,
            totalSummarySize,
            totalSavings: totalFullSize - totalSummarySize,
        };
    }
    /**
     * Get relative path from project root
     */
    getRelativePath(filePath) {
        const absolute = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(filePath);
        return path.relative(this.config.projectRoot, absolute);
    }
    /**
     * Normalize a file path to absolute form
     */
    normalizePath(filePath) {
        return path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.resolve(filePath);
    }
    /**
     * Hash file contents for staleness detection
     */
    hashContent(content) {
        return createHash('sha256').update(content).digest('hex');
    }
    /**
     * Update access order for LRU tracking
     */
    updateAccessOrder(filePath) {
        this.accessOrder = this.accessOrder.filter((p) => p !== filePath);
        this.accessOrder.push(filePath);
    }
    /**
     * Evict least recently used files if over limit
     */
    evictIfNeeded() {
        while (this.summaries.size > this.config.maxTrackedFiles) {
            const oldest = this.accessOrder.shift();
            if (oldest && oldest !== this.activeFile) {
                this.summaries.delete(oldest);
            }
        }
    }
}
// Global singleton instance
let globalState = null;
export function getContextState(config) {
    if (!globalState) {
        globalState = new ContextState(config);
    }
    return globalState;
}
export function resetContextState() {
    globalState = null;
}
//# sourceMappingURL=state.js.map