import * as fs from 'fs';
import * as path from 'path';
import { getContextState } from './state.js';
import { parseFile, isSupported, formatFileHeader } from './parsers/index.js';
/**
 * Format bytes into human-readable size
 */
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Read a file and mark it as active.
 * For supported languages, auto-summarizes the previous active file.
 * For unsupported languages, returns full contents without tracking.
 */
export async function readFile(filePath) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);
    // Read the file
    const content = fs.readFileSync(absolutePath, 'utf8');
    const state = getContextState();
    const relativePath = state.getRelativePath(absolutePath);
    // Check if this file type is supported for summarization
    if (!isSupported(absolutePath)) {
        // Unsupported: return full contents, don't track
        const header = formatFileHeader(relativePath, false);
        return `${header}\n// (Unsupported file type - not tracked for compaction)\n\n${content}`;
    }
    // Summarize the previous active file if there was one
    const previousActive = state.getActiveFile();
    if (previousActive && previousActive !== absolutePath) {
        await summarizeFile(previousActive);
    }
    // Mark this file as active
    state.setActiveFile(absolutePath);
    // Return full contents with header
    const header = formatFileHeader(relativePath, false);
    return `${header}\n\n${content}`;
}
/**
 * Peek at a file's summary without changing the active file.
 * For unsupported languages, returns full contents.
 */
export async function peekFile(filePath) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const state = getContextState();
    const relativePath = state.getRelativePath(absolutePath);
    // Check if this file type is supported
    if (!isSupported(absolutePath)) {
        const header = formatFileHeader(relativePath, false);
        return `${header}\n// (Unsupported file type - returning full contents)\n\n${content}`;
    }
    // Check if this is the active file - return full contents if so
    if (state.isActive(absolutePath)) {
        const header = formatFileHeader(relativePath, false);
        return `${header}\n// (This is the active file)\n\n${content}`;
    }
    // Check for cached summary
    const cached = state.getSummary(absolutePath);
    if (cached && !state.isStale(absolutePath)) {
        const header = formatFileHeader(relativePath, true);
        return `${header}\n\n${cached.summary}`;
    }
    // Generate new summary
    const result = parseFile(absolutePath, content);
    if (result && result.success) {
        state.setSummary(absolutePath, result.formattedSummary, content);
        const header = formatFileHeader(relativePath, true);
        return `${header}\n\n${result.formattedSummary}`;
    }
    // Parsing failed, return full contents
    const header = formatFileHeader(relativePath, false);
    const errorMsg = result && !result.success ? ` (Parse error: ${result.error})` : '';
    return `${header}\n// (Could not generate summary${errorMsg})\n\n${content}`;
}
/**
 * Edit a file using string replacement.
 * Keeps the file as active and updates the cached summary.
 */
export async function editFile(filePath, oldString, newString) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);
    const state = getContextState();
    const relativePath = state.getRelativePath(absolutePath);
    // Read current contents
    const content = fs.readFileSync(absolutePath, 'utf8');
    // Check if old_string exists
    if (!content.includes(oldString)) {
        throw new Error(`The specified old_string was not found in ${relativePath}. ` +
            `Make sure you're using the exact string including whitespace and indentation.`);
    }
    // Check for multiple occurrences
    const occurrences = content.split(oldString).length - 1;
    if (occurrences > 1) {
        throw new Error(`The specified old_string appears ${occurrences} times in ${relativePath}. ` +
            `Please provide a more specific string that uniquely identifies the location.`);
    }
    // Perform the replacement
    const newContent = content.replace(oldString, newString);
    // Write the file
    fs.writeFileSync(absolutePath, newContent, 'utf8');
    // Check if this file type is supported for summarization
    if (!isSupported(absolutePath)) {
        return `Successfully edited ${relativePath} (unsupported file type - not tracked)`;
    }
    // Summarize previous active file if different
    const previousActive = state.getActiveFile();
    if (previousActive && previousActive !== absolutePath) {
        await summarizeFile(previousActive);
    }
    // Mark as active and update summary cache
    state.setActiveFile(absolutePath);
    // Regenerate summary for cache
    const result = parseFile(absolutePath, newContent);
    if (result && result.success) {
        state.setSummary(absolutePath, result.formattedSummary, newContent);
    }
    return `Successfully edited ${relativePath}`;
}
/**
 * Write a new file.
 * Marks the file as active if it's a supported language.
 */
export async function writeFile(filePath, content) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);
    const state = getContextState();
    const relativePath = state.getRelativePath(absolutePath);
    // Create directory if needed
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Write the file
    fs.writeFileSync(absolutePath, content, 'utf8');
    // Check if this file type is supported
    if (!isSupported(absolutePath)) {
        return `Successfully wrote ${relativePath} (unsupported file type - not tracked)`;
    }
    // Summarize previous active file if there was one
    const previousActive = state.getActiveFile();
    if (previousActive && previousActive !== absolutePath) {
        await summarizeFile(previousActive);
    }
    // Mark as active
    state.setActiveFile(absolutePath);
    // Generate initial summary for cache
    const result = parseFile(absolutePath, content);
    if (result && result.success) {
        state.setSummary(absolutePath, result.formattedSummary, content);
    }
    return `Successfully wrote ${relativePath}`;
}
/**
 * Get the status of all tracked files.
 */
export async function fileStatus() {
    const state = getContextState();
    const status = state.getStatus();
    const lines = ['Context Status', '==============', ''];
    // Active file
    if (status.activeFile) {
        const relativePath = state.getRelativePath(status.activeFile);
        try {
            const content = fs.readFileSync(status.activeFile, 'utf8');
            const size = Buffer.byteLength(content, 'utf8');
            lines.push(`Active: ${relativePath} (full, ${formatSize(size)})`);
        }
        catch {
            lines.push(`Active: ${relativePath} (file not found)`);
        }
    }
    else {
        lines.push('Active: (none)');
    }
    lines.push('');
    // Cached summaries
    if (status.summaries.length > 0) {
        lines.push('Cached Summaries:');
        for (const s of status.summaries) {
            const savings = formatSize(s.savings);
            lines.push(`  ${s.relativePath.padEnd(40)} ${formatSize(s.summarySize).padStart(8)} ` +
                `(was ${formatSize(s.fullSize)}, saved ${savings})`);
        }
        lines.push('');
    }
    else {
        lines.push('Cached Summaries: (none)');
        lines.push('');
    }
    // Totals
    if (status.summaries.length > 0) {
        const activeSize = status.activeFile
            ? Buffer.byteLength(fs.readFileSync(status.activeFile, 'utf8'), 'utf8')
            : 0;
        const totalContext = activeSize + status.totalSummarySize;
        const totalWithoutCompaction = activeSize + status.totalFullSize;
        const savingsPercent = totalWithoutCompaction > 0
            ? ((status.totalSavings / totalWithoutCompaction) * 100).toFixed(0)
            : 0;
        lines.push(`Total Context:        ${formatSize(totalContext)}`);
        lines.push(`Without Compaction:   ${formatSize(totalWithoutCompaction)}`);
        lines.push(`Savings:              ${formatSize(status.totalSavings)} (${savingsPercent}%)`);
    }
    return lines.join('\n');
}
/**
 * Forget a file (remove it from tracking).
 */
export async function forgetFile(filePath) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);
    const state = getContextState();
    const relativePath = state.getRelativePath(absolutePath);
    const wasTracked = state.forget(absolutePath);
    if (wasTracked) {
        return `Removed ${relativePath} from tracking`;
    }
    else {
        return `${relativePath} was not being tracked`;
    }
}
/**
 * Internal: summarize a file and cache the result
 */
async function summarizeFile(filePath) {
    const state = getContextState();
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const result = parseFile(filePath, content);
        if (result && result.success) {
            state.setSummary(filePath, result.formattedSummary, content);
        }
    }
    catch {
        // File might have been deleted, ignore
    }
}
//# sourceMappingURL=tools.js.map