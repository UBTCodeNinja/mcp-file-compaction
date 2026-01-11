# MCP File Compaction

An MCP server that reduces Claude context window costs by automatically summarizing files to their public interfaces.

## The Problem

When Claude works on large tasks across multiple files, the context window grows continuously. Each API request costs based on the **full size** of the context, not just new tokens. This leads to quadratic cost growth:

1. Implement `ptr.rs` (2KB) → Context: 2KB
2. Implement `raw_page.rs` using `ptr.rs` (3KB) → Context: 5KB
3. Implement `paged_pool.rs` using both (4KB) → Context: 9KB

After finishing a file, Claude doesn't need the full implementation—just the public interface (structs, functions, traits).

## The Solution

This MCP server:
- **Tracks the "active" file** — the one you're currently editing (full contents)
- **Auto-summarizes inactive files** — when you switch files, the previous one is summarized to just its public API
- **Uses AST parsing** — deterministic, fast, no LLM calls for summarization
- **Handles unsupported languages gracefully** — returns full contents without tracking

## Installation

### From GitHub (recommended)

```bash
npx github:YOUR_USERNAME/mcp-file-compaction
```

### Local development

```bash
git clone https://github.com/YOUR_USERNAME/mcp-file-compaction.git
cd mcp-file-compaction
npm install
npm run build
```

## Configuration

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "file-compaction": {
      "command": "npx",
      "args": ["github:YOUR_USERNAME/mcp-file-compaction"]
    }
  }
}
```

Or for local development:

```json
{
  "mcpServers": {
    "file-compaction": {
      "command": "node",
      "args": ["/path/to/mcp-file-compaction/dist/index.js"]
    }
  }
}
```

Add to your `CLAUDE.md`:

```markdown
## File Operations

Use the file-compaction MCP server for file operations:
- `read_file` instead of `Read` when you need full file contents
- `peek_file` when you only need to check interfaces
- `edit_file` instead of `Edit` for modifications
- `write_file` instead of `Write` for new files
- `file_status` to see tracked files and context savings

This reduces context window size by keeping only summaries of inactive files.
```

## Tools

### read_file
Read a file and mark it as the active file. When you switch to a different file, the previous file is automatically summarized.

```json
{ "path": "src/lib.rs" }
```

### peek_file
Get a summary of a file's public interface without changing the active file. Useful for checking APIs.

```json
{ "path": "src/ptr.rs" }
```

### edit_file
Edit a file by replacing a specific string. The file becomes (or remains) the active file.

```json
{
  "path": "src/lib.rs",
  "old_string": "fn old_name(",
  "new_string": "fn new_name("
}
```

### write_file
Write content to a file, creating it if needed. The file becomes the active file.

```json
{
  "path": "src/new_module.rs",
  "content": "//! New module\n\npub fn hello() {}\n"
}
```

### file_status
Show all tracked files with size comparison and savings.

```
Context Status
==============
Active: src/paged_pool.rs (full, 4.2 KB)

Cached Summaries:
  src/ptr.rs        312 B  (was 2.1 KB, saved 1.8 KB)
  src/raw_page.rs   428 B  (was 3.4 KB, saved 3.0 KB)

Total Context:        5.2 KB
Without Compaction:   11.5 KB
Savings:              6.3 KB (55%)
```

### forget_file
Remove a file from tracking entirely.

```json
{ "path": "src/old_file.rs" }
```

## Supported Languages

Currently supported for summarization:
- **Rust** (.rs) — extracts public structs, enums, traits, functions, type aliases, constants, and re-exports

Unsupported file types are read/edited normally without tracking—they won't interfere with compaction.

## How Summaries Work

For a Rust file like:

```rust
//! Type-safe pointer wrappers.

use std::marker::PhantomData;

#[derive(Debug, Clone)]
pub struct Ptr<T> {
    raw: *mut T,
    _marker: PhantomData<T>,
}

impl<T> Ptr<T> {
    pub fn new(raw: *mut T) -> Self {
        Self { raw, _marker: PhantomData }
    }

    pub fn is_null(&self) -> bool {
        self.raw.is_null()
    }

    // Private helper
    fn internal_check(&self) -> bool {
        !self.raw.is_null()
    }
}
```

The summary becomes:

```rust
// Purpose: Type-safe pointer wrappers.

#[derive(Debug, Clone)]
pub struct Ptr<T> { ... }
impl<T> Ptr<T> {
    pub fn new(raw: *mut T) -> Self;
    pub fn is_null(&self) -> bool;
}
```

Private items, implementation details, and doc comments are condensed—only the public interface remains.

## License

MIT
