# Claude Code Instructions

This project implements an MCP server for file compaction.

## File Operations

Use the file-compaction MCP tools for file operations to reduce context window size:

- `read_file` instead of `Read` when you need full file contents
- `peek_file` when you only need to check interfaces of files you've previously read
- `edit_file` instead of `Edit` for modifications
- `write_file` instead of `Write` for new files
- `file_status` to see tracked files and context savings
- `forget_file` to remove files from tracking

The server automatically summarizes inactive files to their public interface, significantly reducing context size for multi-file work.

## Supported Languages

- Rust (.rs files) are summarized to public structs, enums, traits, functions, etc.
- Other file types are passed through without summarization

## Project Structure

```
src/
  index.ts          - MCP server entry point
  state.ts          - Context state management
  tools.ts          - Tool implementations
  parsers/
    index.ts        - Parser registry
    types.ts        - Summary type definitions
    rust.ts         - Rust AST parser using tree-sitter
```
