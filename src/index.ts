#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  readFile,
  peekFile,
  editFile,
  writeFile,
  fileStatus,
  forgetFile,
} from './tools.js';
import { getSupportedExtensions } from './parsers/index.js';

const server = new Server(
  {
    name: 'mcp-file-compaction',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: 'read_file',
    description: `Read a file and mark it as the active file. When you switch to a different file, the previous file is automatically summarized to just its public interface, reducing context size.

Supported languages for summarization: ${getSupportedExtensions().join(', ')}

For unsupported file types, returns full contents without tracking (same as standard file read).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read (absolute or relative)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'peek_file',
    description: `Get a summary of a file's public interface without changing the active file. Useful for checking APIs of files you've already worked on.

Returns:
- For the active file: full contents
- For previously read files: cached summary (public structs, functions, traits, etc.)
- For unsupported file types: full contents`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to peek at',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: `Edit a file by replacing a specific string. The file becomes (or remains) the active file.

The old_string must:
- Match exactly, including whitespace and indentation
- Appear exactly once in the file (for safety)

After editing, the file's cached summary is updated.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to replace (must be unique in the file)',
        },
        new_string: {
          type: 'string',
          description: 'The string to replace it with',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: `Write content to a file, creating it if it doesn't exist. The file becomes the active file.

Creates parent directories if needed.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_status',
    description: `Show the status of all tracked files including:
- The currently active file (full contents in context)
- Cached summaries with size comparison
- Total context savings from compaction`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'forget_file',
    description: `Remove a file from tracking. Useful for cleanup or when you no longer need a file's interface in context.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to forget',
        },
      },
      required: ['path'],
    },
  },
];

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'read_file': {
        const path = args?.path as string;
        if (!path) {
          throw new McpError(ErrorCode.InvalidParams, 'path is required');
        }
        const result = await readFile(path);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'peek_file': {
        const path = args?.path as string;
        if (!path) {
          throw new McpError(ErrorCode.InvalidParams, 'path is required');
        }
        const result = await peekFile(path);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'edit_file': {
        const path = args?.path as string;
        const oldString = args?.old_string as string;
        const newString = args?.new_string as string;
        if (!path || oldString === undefined || newString === undefined) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'path, old_string, and new_string are required'
          );
        }
        const result = await editFile(path, oldString, newString);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'write_file': {
        const path = args?.path as string;
        const content = args?.content as string;
        if (!path || content === undefined) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'path and content are required'
          );
        }
        const result = await writeFile(path, content);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'file_status': {
        const result = await fileStatus();
        return { content: [{ type: 'text', text: result }] };
      }

      case 'forget_file': {
        const path = args?.path as string;
        if (!path) {
          throw new McpError(ErrorCode.InvalidParams, 'path is required');
        }
        const result = await forgetFile(path);
        return { content: [{ type: 'text', text: result }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP File Compaction server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
