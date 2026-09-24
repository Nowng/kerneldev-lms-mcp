/**
 * kerneldev-lms-mcp — LM Studio Plugin entry point.
 *
 * This is the main entry point for the LM Studio plugin. It exports a `main`
 * function that LM Studio calls at runtime, and the `toolsProvider` that
 * can be used independently.
 *
 * The plugin wraps the original kerneldev-mcp Python MCP server (kept as an
 * untouched git clone) and exposes all its tools to LM Studio via the
 * @lmstudio/sdk tool() API.
 *
 * See: https://github.com/josefbacik/kerneldev-mcp (original project)
 */

import { Tool, ToolsProviderController } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider.js";

/**
 * LM Studio plugin entry point.
 *
 * @param pluginContext — LM Studio plugin context for registering tools.
 */
export async function main(pluginContext: {
  withToolsProvider: (
    provider: (ctl: ToolsProviderController) => Promise<Tool[]>,
  ) => void;
}): Promise<void> {
  // Pass the toolsProvider function directly to LM Studio.
  // LM Studio will call it with a ToolsProviderController at runtime.
  pluginContext.withToolsProvider(toolsProvider);
}

// Also export toolsProvider for independent use.
export { toolsProvider };
