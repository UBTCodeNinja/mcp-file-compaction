# File Edit Compaction for Claude Code

An MCP server that reduces Claude Code context window costs by automatically summarizing files after edits, keeping only public interfaces and high-level purposes in context.

## Problem Statement

When Claude works on large tasks, the context window grows continuously. Each request sent to Claude has a cost based on the **full size** of the context window, not just new tokens. This leads to **quadratic cost growth** when building dependent files.

### Example: Building `latch_data`

1. Implement `ptr.rs` (2KB) → Context: 2KB
2. Implement `raw_page.rs` using `ptr.rs` interfaces (3KB) → Context: 5KB
3. Implement `paged_pool.rs` using `raw_page.rs` interfaces (4KB) → Context: 9KB

Each subsequent file pays the full cost of all previous files, even though Claude only needs the **interfaces**, not the full implementations.

### The Insight

After finishing `ptr.rs`, Claude doesn't need:
- Private helper functions
- Implementation details
- Internal comments

Claude only needs:
- What the file does (purpose)
- What it exposes (public API signatures)

## Proposed Solution

An MCP server that:

1. **Tracks the "active" file** - the one Claude is currently working on (full contents)
2. **Auto-summarizes inactive files** - when Claude moves to a new file, the previous one gets summarized
3. **Uses deterministic AST parsing** - no LLM calls for summarization (that would defeat the purpose)
4. **Deduplicates context** - tracks file hashes, keeps only most recent version

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Server                              │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ AST Parsers │  │ Summary Cache│  │ Active File       │   │
│  │ (per-lang)  │  │  (HashMap)   │  │ Tracker           │   │
│  └─────────────┘  └──────────────┘  └───────────────────┘   │
│         │                │                    │              │
│         ▼                ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   State Manager                      │    │
│  │  - Tracks which files are in Claude's context        │    │
│  │  - Manages active/inactive transitions               │    │
│  │  - Computes savings metrics                          │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Exposed Tools                           │
│                                                              │
│  context_read(path)                                          │
│    → Returns full file contents                              │
│    → Marks file as "active"                                  │
│    → Auto-summarizes previous active file                    │
│                                                              │
│  context_peek(path)                                          │
│    → Returns summary only (public API + purpose)             │
│    → Does NOT change active file                             │
│                                                              │
│  context_edit(path, old_string, new_string)                  │
│    → Performs edit                                           │
│    → Keeps file as active                                    │
│    → Updates cached summary                                  │
│                                                              │
│  context_write(path, content)                                │
│    → Writes new file                                         │
│    → Marks as active                                         │
│    → Generates initial summary                               │
│                                                              │
│  context_status()                                            │
│    → Lists all tracked files                                 │
│    → Shows full vs summary sizes                             │
│    → Reports total context savings                           │
│                                                              │
│  context_forget(path)                                        │
│    → Removes file from tracking entirely                     │
│    → Useful for cleanup                                      │
└─────────────────────────────────────────────────────────────┘
```

## Rust Summarizer Design

Using the `syn` crate for AST parsing:

### Data Structures

```rust
use std::path::PathBuf;
use std::collections::HashMap;

/// Summary of a single Rust file
pub struct FileSummary {
    /// From //! module-level doc comments
    pub purpose: Option<String>,

    /// Public struct definitions
    pub structs: Vec<StructSummary>,

    /// Public trait definitions
    pub traits: Vec<TraitSummary>,

    /// Public enum definitions
    pub enums: Vec<EnumSummary>,

    /// Standalone public functions
    pub functions: Vec<FunctionSummary>,

    /// Public type aliases
    pub type_aliases: Vec<TypeAliasSummary>,

    /// Public constants and statics
    pub constants: Vec<ConstantSummary>,

    /// Re-exports (pub use ...)
    pub reexports: Vec<String>,
}

pub struct StructSummary {
    pub name: String,
    pub doc: Option<String>,
    pub generics: String,  // e.g., "<T: Clone, U>"
    pub fields: Vec<FieldSummary>,  // Only pub fields
    pub methods: Vec<FunctionSummary>,  // From impl blocks
}

pub struct TraitSummary {
    pub name: String,
    pub doc: Option<String>,
    pub generics: String,
    pub bounds: String,  // Supertrait bounds
    pub methods: Vec<FunctionSummary>,
}

pub struct FunctionSummary {
    pub name: String,
    pub doc: Option<String>,
    pub signature: String,  // Full signature as string
    pub is_unsafe: bool,
    pub is_async: bool,
}

pub struct EnumSummary {
    pub name: String,
    pub doc: Option<String>,
    pub generics: String,
    pub variants: Vec<String>,  // Variant names with field hints
}

pub struct TypeAliasSummary {
    pub name: String,
    pub doc: Option<String>,
    pub definition: String,  // The full type = ... part
}

pub struct ConstantSummary {
    pub name: String,
    pub doc: Option<String>,
    pub ty: String,
    pub is_static: bool,
}

pub struct FieldSummary {
    pub name: String,
    pub ty: String,
    pub doc: Option<String>,
}
```

### Output Format

The summary should be human-readable and useful for Claude:

```
// === src/ptr.rs ===
// Purpose: Type-safe pointer wrapper for raw memory operations with
// lifetime tracking and null-safety guarantees.

pub struct Ptr<T> {
    // Wrapper around raw pointer with type safety
}

impl<T> Ptr<T> {
    pub fn new(raw: *mut T) -> Self
    pub fn null() -> Self
    pub fn is_null(&self) -> bool
    pub fn as_ptr(&self) -> *const T
    pub fn as_mut_ptr(&mut self) -> *mut T
    pub unsafe fn read(&self) -> T
    pub unsafe fn write(&mut self, value: T)
    pub unsafe fn offset(&self, count: isize) -> Self
}

pub trait Pointable: Sized {
    fn into_ptr(self) -> Ptr<Self>
    unsafe fn from_ptr(ptr: Ptr<Self>) -> Self
}

pub type RawPtr = Ptr<u8>;
```

### Coding Standard: Purpose Comments

To make summarization reliable, adopt a coding standard requiring module-level doc comments:

```rust
//! Brief one-line purpose of this module.
//!
//! Optional longer description that will be included in the summary.
//! Can span multiple lines but should be concise.

use crate::whatever;

// ... rest of file
```

The summarizer extracts the `//!` comments as the "purpose" field.

## State Management

```rust
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;

pub struct ContextState {
    /// The file Claude is currently working on (full contents in context)
    active_file: Option<PathBuf>,

    /// Cached summaries for inactive files
    /// Key: canonical path
    /// Value: (summary_text, content_hash, full_size, summary_size)
    summaries: HashMap<PathBuf, CachedSummary>,

    /// Access order for potential LRU eviction
    access_order: VecDeque<PathBuf>,

    /// Configuration
    config: ContextConfig,
}

pub struct CachedSummary {
    /// The generated summary text
    pub summary: String,

    /// Hash of full file contents (for staleness detection)
    pub content_hash: u64,

    /// Size of full file in bytes
    pub full_size: usize,

    /// Size of summary in bytes
    pub summary_size: usize,

    /// Timestamp of last access
    pub last_accessed: std::time::Instant,
}

pub struct ContextConfig {
    /// Maximum number of files to track
    pub max_tracked_files: usize,

    /// Whether to include private items in summaries (for debugging)
    pub include_private: bool,

    /// Maximum lines for doc comments in summaries
    pub max_doc_lines: usize,
}
```

## Deduplication Strategy

When the same file appears multiple times in a conversation:

1. **Hash-based identity**: Use content hash + path to identify files
2. **Keep most recent**: When a file is re-read or edited, update the cached version
3. **Staleness detection**: If file on disk differs from cached hash, regenerate summary

```rust
impl ContextState {
    pub fn should_regenerate(&self, path: &PathBuf) -> bool {
        if let Some(cached) = self.summaries.get(path) {
            let current_hash = hash_file_contents(path);
            current_hash != cached.content_hash
        } else {
            true
        }
    }
}
```

## Status Reporting

The `context_status` tool provides visibility into savings:

```
Context Status
==============
Active: src/paged_pool.rs (full, 4.2 KB)

Cached Summaries:
  src/ptr.rs        312 B  (was 2.1 KB, saved 1.8 KB)
  src/raw_page.rs   428 B  (was 3.4 KB, saved 3.0 KB)
  src/slot_map.rs   256 B  (was 1.8 KB, saved 1.5 KB)

Total Context:  5.2 KB
Without Compaction: 11.5 KB
Savings: 6.3 KB (55%)
```

## Handling Non-Rust Files

### Markdown Files

Options:
1. **Keep full** - Documentation files are usually needed in full
2. **Extract structure** - Headers, code blocks, links
3. **Configurable** - Let user decide per-file or per-extension

```rust
pub struct MarkdownSummary {
    /// First paragraph or YAML frontmatter description
    pub purpose: Option<String>,

    /// Header hierarchy
    pub headers: Vec<(usize, String)>,  // (level, text)

    /// Code block languages present
    pub code_blocks: Vec<String>,
}
```

### Other Languages (Future)

The architecture supports pluggable parsers:

```rust
pub trait LanguageParser: Send + Sync {
    fn extensions(&self) -> &[&str];
    fn parse(&self, content: &str) -> Result<FileSummary, ParseError>;
}

pub struct ParserRegistry {
    parsers: HashMap<String, Box<dyn LanguageParser>>,
}
```

Future parsers could use:
- **TypeScript/JavaScript**: `swc` or `tree-sitter`
- **Python**: `tree-sitter-python`
- **Go**: `tree-sitter-go`
- **C/C++**: `tree-sitter-c`, `tree-sitter-cpp`

## Implementation Lift

### MVP (Rust-only)

| Component | Effort | Notes |
|-----------|--------|-------|
| MCP server skeleton | 2-3 hours | Tool registration, JSON-RPC |
| Rust parser (`syn`) | 4-6 hours | Extract all pub items |
| Summary formatter | 2-3 hours | Generate readable output |
| State management | 2-3 hours | Active tracking, caching |
| Testing | 3-4 hours | Real codebase testing |
| **Total** | **13-19 hours** | |

### Post-MVP Enhancements

| Feature | Effort | Priority |
|---------|--------|----------|
| Markdown handling | 2-3 hours | High |
| Token counting | 2-3 hours | Medium |
| Configurable verbosity | 1-2 hours | Medium |
| TypeScript parser | 4-6 hours | Low |
| LRU eviction | 1-2 hours | Low |
| Metrics/telemetry | 2-3 hours | Low |

## Open Questions & Design Decisions

### 1. Tool Naming Strategy

**Option A**: Shadow built-in tools
- `read_file`, `edit_file`, `write_file` (same names)
- Pro: Claude uses them naturally
- Con: May conflict with built-in tools

**Option B**: Prefixed tools
- `context_read`, `context_edit`, `context_write`
- Pro: Clear separation, no conflicts
- Con: Claude might still use built-in tools

**Option C**: Completely different paradigm
- `open_file`, `close_file`, `get_interface`
- Pro: Explicit file lifecycle
- Con: Different mental model

**Recommendation**: Option B (prefixed tools) for MVP, evaluate shadowing later.

### 2. When to Summarize

**Option A**: Immediate (on file switch)
- Previous file summarized as soon as new file becomes active
- Pro: Always up-to-date
- Con: Slight latency on every switch

**Option B**: Lazy (on next read of that file)
- File marked as "needs summary" but not processed until needed
- Pro: No wasted work
- Con: Delayed savings

**Option C**: Background (async)
- Summarization happens in background thread
- Pro: No latency impact
- Con: More complex implementation

**Recommendation**: Option A for MVP (simpler), consider C for optimization.

### 3. Summary Verbosity Levels

```rust
pub enum VerbosityLevel {
    /// Just names and signatures, no docs
    Minimal,

    /// Names, signatures, first line of docs
    Standard,

    /// Names, signatures, full docs
    Verbose,
}
```

Could be configurable per-project or per-file-type.

### 4. Handling Impl Blocks

Rust impl blocks can be:
- Inherent impls (`impl Foo { ... }`)
- Trait impls (`impl Bar for Foo { ... }`)
- Generic impls (`impl<T> Foo<T> { ... }`)

**Decision**: Include all pub methods from inherent impls, note trait impls exist but don't duplicate trait methods.

### 5. Macro-Generated Code

`syn` parses source code, not expanded macros. Items generated by:
- `#[derive(...)]`
- Procedural macros
- `macro_rules!`

Won't appear in summaries.

**Mitigation**:
- Note derive macros in summary: `#[derive(Debug, Clone)]`
- Trust that derived implementations follow standard patterns

## Usage Examples

### Basic Workflow

```
User: Implement the Pool struct in pool.rs

Claude: [calls context_read("src/ptr.rs")]
        [receives summary of ptr.rs]

        [calls context_read("src/pool.rs")]
        [receives full contents, ptr.rs now summarized]

        [calls context_edit("src/pool.rs", ...)]
        [makes changes, pool.rs stays active]

        [calls context_status()]
        Shows: pool.rs (active, full), ptr.rs (summary)
```

### Peeking at Interface

```
User: What methods does Ptr expose?

Claude: [calls context_peek("src/ptr.rs")]
        [receives summary without changing active file]

        "Ptr exposes these methods: new, null, is_null, ..."
```

### Multi-File Refactoring

```
User: Rename Ptr to SafePtr across the codebase

Claude: [calls context_status() to see tracked files]

        [for each file, calls context_read to make active, edits, moves on]

        [at end, all files are summarized except the last one touched]
```

## Integration with Claude Code

### MCP Server Configuration

In `.mcp.json` or Claude Code settings:

```json
{
  "mcpServers": {
    "context-compactor": {
      "command": "context-compactor-server",
      "args": ["--project-root", "."],
      "env": {}
    }
  }
}
```

### Custom Instructions

Add to `CLAUDE.md`:

```markdown
## File Operations

Use the context-compactor MCP server for file operations:
- `context_read` instead of `Read` when you need full file contents
- `context_peek` when you only need to check interfaces
- `context_edit` instead of `Edit` for modifications
- `context_write` instead of `Write` for new files

This reduces context window size and costs by keeping only
summaries of inactive files.
```

## Future Ideas

### 1. Semantic Compression

Beyond AST extraction, could use lightweight models (local, fast) to:
- Generate more meaningful summaries
- Identify which parts of implementation are "interesting"
- Compress repetitive patterns

### 2. Cross-File Dependency Tracking

Track which files depend on which:
- If `pool.rs` imports from `ptr.rs`, note that in metadata
- Could inform smarter summarization (keep more detail for heavily-depended-on files)

### 3. Conversation-Aware Relevance

Track which parts of files Claude actually referenced:
- If Claude only used 2 methods from a 20-method struct, maybe only keep those 2 in summary
- Risk: might need those other methods later

### 4. Integration with IDE

Could sync with editor state:
- If user has a file open in VSCode, treat it as "active"
- Coordinate with LSP for richer type information

### 5. Diff-Based Updates

Instead of regenerating full summaries:
- Track what changed between edits
- Update summary incrementally
- Faster for large files with small changes

## Repository Structure

```
context-compactor/
├── Cargo.toml
├── README.md
├── src/
│   ├── main.rs              # MCP server entry point
│   ├── lib.rs               # Library root
│   ├── server.rs            # MCP protocol handling
│   ├── state.rs             # ContextState management
│   ├── tools/
│   │   ├── mod.rs
│   │   ├── read.rs          # context_read implementation
│   │   ├── peek.rs          # context_peek implementation
│   │   ├── edit.rs          # context_edit implementation
│   │   ├── write.rs         # context_write implementation
│   │   ├── status.rs        # context_status implementation
│   │   └── forget.rs        # context_forget implementation
│   ├── parsers/
│   │   ├── mod.rs           # Parser registry
│   │   ├── rust.rs          # Rust parser (syn)
│   │   └── markdown.rs      # Markdown parser
│   ├── summary/
│   │   ├── mod.rs
│   │   ├── types.rs         # FileSummary, etc.
│   │   └── formatter.rs     # Summary -> String
│   └── config.rs            # Configuration handling
├── tests/
│   ├── rust_parser_tests.rs
│   ├── integration_tests.rs
│   └── fixtures/
│       └── sample_rust_files/
└── examples/
    └── basic_usage.rs
```

## Success Metrics

1. **Context size reduction**: Target 50%+ reduction for typical workflows
2. **Latency**: Summarization should add <100ms per file
3. **Accuracy**: Summaries should contain all information needed for dependent files
4. **Adoption**: Claude should naturally use the tools without extra prompting

## References

- [MCP Specification](https://modelcontextprotocol.io/)
- [syn crate documentation](https://docs.rs/syn/)
- [Claude Code documentation](https://docs.anthropic.com/claude-code)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/) (for future multi-language support)
