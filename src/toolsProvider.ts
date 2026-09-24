/**
 * toolsProvider — LM Studio Plugin entry point.
 *
 * This module exposes the original kerneldev-mcp MCP tools to LM Studio.
 * It works as a lightweight TypeScript wrapper:
 *
 *   1. Spawns the original kerneldev-mcp Python MCP server as a subprocess.
 *   2. Lists all tools from the Python server (including dynamically
 *      generated ones like `device_pool_*`).
 *   3. Creates an LM Studio `tool()` definition for each, converting the
 *      JSON schema to a Zod schema for validation + autocompletion.
 *   4. Forwards tool calls to the Python subprocess and returns results.
 *
 * The original kerneldev-mcp source tree is never modified.
 */

import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import {
  findPythonInterpreter,
  PythonMcpClient,
  KERNELDEV_MCP_DIR,
} from "./core/pythonMcpClient.js";
import { jsonSchemaToZodFull } from "./core/jsonSchemaToZod.js";

// ---------------------------------------------------------------------------
// toolsProvider
// ---------------------------------------------------------------------------

/**
 * LM Studio plugin tools provider.
 *
 * The controller (`ctl`) is provided by LM Studio at runtime. We use it to
 * initialize a PythonMcpClient that spawns the original kerneldev-mcp server.
 *
 * Note: The Python subprocess is spawned lazily on the first tool call and
 * kept alive for the lifetime of the plugin. This avoids the overhead of
 * restarting the process for every tool invocation.
 */
export async function toolsProvider(
  ctl: ToolsProviderController,
): Promise<Tool[]> {
  const pythonPath = findPythonInterpreter();
  const client = new PythonMcpClient(pythonPath, KERNELDEV_MCP_DIR);

  // Initialize the Python MCP client (spawns the subprocess).
  await client.initialize();

  // List all tools from the original kerneldev-mcp server.
  const mcpTools = await client.listTools();

  const tools: Tool[] = [];

  for (const mcpTool of mcpTools) {
    // Convert the JSON schema (from Python) to a ZodRawShape (Record<string, ZodType>)
    // for validation + autocompletion in LM Studio.
    const { shape, description: schemaDescription } = jsonSchemaToZodFull(mcpTool.inputSchema);

    const lmTool = tool({
      name: mcpTool.name,
      description: `${mcpTool.description}\n\nSchema:\n${schemaDescription}`,
      parameters: shape,
      implementation: async (args, { signal, status, warn }) => {
        status(`Running ${mcpTool.name}…`);

        // Respect cancellation.
        if (signal.aborted) {
          return `Cancelled: ${mcpTool.name} was aborted.`;
        }

        try {
          const result = await client.callTool(mcpTool.name, args || {});
          status(`Finished ${mcpTool.name}`);
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          if (error instanceof Error && error.name === "AbortError") {
            return `Cancelled: ${mcpTool.name} was aborted.`;
          }
          return `Error running ${mcpTool.name}: ${message}`;
        }
      },
    });

    tools.push(lmTool);
  }

  // Note: LM Studio does not provide a direct "onDestroy" hook in the
  // current SDK version. The Python subprocess will be killed when the
  // plugin process exits.

  return tools;
}

// Re-export for the standalone MCP server entry point.
export { PythonMcpClient } from "./core/pythonMcpClient.js";
