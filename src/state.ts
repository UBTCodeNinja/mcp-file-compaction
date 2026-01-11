import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

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

export class ContextState {
  /** The file Claude is currently working on (full contents in context) */
  private activeFile: string | null = null;

  /** Cached summaries for inactive files */
  private summaries: Map<string, CachedSummary> = new Map();

  /** Access order for potential LRU eviction */
  private accessOrder: string[] = [];

  /** Configuration */
  private config: ContextConfig;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = {
      maxTrackedFiles: config.maxTrackedFiles ?? 50,
      maxDocLines: config.maxDocLines ?? 5,
      projectRoot: config.projectRoot ?? process.cwd(),
    };
  }

  /**
   * Get the currently active file path
   */
  getActiveFile(): string | null {
    return this.activeFile;
  }

  /**
   * Set a file as active, returning the previous active file (if any)
   */
  setActiveFile(filePath: string): string | null {
    const previousActive = this.activeFile;
    this.activeFile = this.normalizePath(filePath);
    this.updateAccessOrder(this.activeFile);
    return previousActive;
  }

  /**
   * Clear the active file without setting a new one
   */
  clearActiveFile(): void {
    this.activeFile = null;
  }

  /**
   * Check if a file is currently active
   */
  isActive(filePath: string): boolean {
    return this.activeFile === this.normalizePath(filePath);
  }

  /**
   * Get cached summary for a file
   */
  getSummary(filePath: string): CachedSummary | undefined {
    return this.summaries.get(this.normalizePath(filePath));
  }

  /**
   * Store a summary for a file
   */
  setSummary(
    filePath: string,
    summary: string,
    fullContent: string
  ): void {
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
  isStale(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);
    const cached = this.summaries.get(normalizedPath);

    if (!cached) return true;

    try {
      const currentContent = fs.readFileSync(filePath, 'utf8');
      const currentHash = this.hashContent(currentContent);
      return currentHash !== cached.contentHash;
    } catch {
      return true;
    }
  }

  /**
   * Remove a file from tracking
   */
  forget(filePath: string): boolean {
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
  } {
    const summaryList = Array.from(this.summaries.entries()).map(
      ([path, cached]) => ({
        path,
        relativePath: cached.relativePath,
        fullSize: cached.fullSize,
        summarySize: cached.summarySize,
        savings: cached.fullSize - cached.summarySize,
        lastAccessed: cached.lastAccessed,
      })
    );

    const totalFullSize = summaryList.reduce((sum, s) => sum + s.fullSize, 0);
    const totalSummarySize = summaryList.reduce(
      (sum, s) => sum + s.summarySize,
      0
    );

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
  getRelativePath(filePath: string): string {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(filePath);
    return path.relative(this.config.projectRoot, absolute);
  }

  /**
   * Normalize a file path to absolute form
   */
  private normalizePath(filePath: string): string {
    return path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(filePath);
  }

  /**
   * Hash file contents for staleness detection
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Update access order for LRU tracking
   */
  private updateAccessOrder(filePath: string): void {
    this.accessOrder = this.accessOrder.filter((p) => p !== filePath);
    this.accessOrder.push(filePath);
  }

  /**
   * Evict least recently used files if over limit
   */
  private evictIfNeeded(): void {
    while (this.summaries.size > this.config.maxTrackedFiles) {
      const oldest = this.accessOrder.shift();
      if (oldest && oldest !== this.activeFile) {
        this.summaries.delete(oldest);
      }
    }
  }
}

// Global singleton instance
let globalState: ContextState | null = null;

export function getContextState(config?: Partial<ContextConfig>): ContextState {
  if (!globalState) {
    globalState = new ContextState(config);
  }
  return globalState;
}

export function resetContextState(): void {
  globalState = null;
}
