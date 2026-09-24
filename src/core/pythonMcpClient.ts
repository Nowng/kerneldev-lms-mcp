/**
 * PythonMcpClient — bridges the LM Studio plugin / standalone MCP server
 * to the original kerneldev-mcp Python MCP server.
 *
 * The original kerneldev-mcp project is a Python MCP server that communicates
 * over stdio using the Model Context Protocol (MCP). This client:
 *   1. Ensures the Python venv exists (created by `scripts/setup.cjs`, or
 *      lazily recreated here if that step was skipped/failed).
 *   2. Spawns the Python MCP server as a local child process (using the
 *      venv's Python interpreter).
 *   3. Connects to it via the MCP SDK's StdioClientTransport.
 *   4. Lists available tools from the Python server.
 *   5. Forwards tool calls to the Python server and returns the results.
 *
 * The original kerneldev-mcp source tree is NEVER modified. It is cloned by
 * the `scripts/setup.cjs` postinstall hook (or the runtime fallback below)
 * and kept as a git clone that can be updated later with `git pull`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool, McpError, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import * as path from "path";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

// The compiled JS lives in `dist/`. The `kerneldev-mcp/` directory sits at
// the project root.  __dirname points into `dist/core/` (compiled) or `src/core/`
// (source), so we go up TWO levels to reach the project root reliably.
//
// NOTE on __dirname depths:
//   - Source context (lms dev / tsc):  __dirname = <project>/src/core/  (3 levels deep)
//     → path.resolve(__dirname, "../..")  = <project>  ✓
//   - Bundled dev.js context:          __dirname = <project>/.lmstudio/  (2 levels deep)
//     → path.resolve(__dirname, "../..")  = <parent>  ✗ (one level too far)
// We detect the bundled context and adjust accordingly.
const PROJECT_ROOT = __dirname.includes(".lmstudio")
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "../..");
export const KERNELDEV_MCP_DIR = path.resolve(PROJECT_ROOT, "kerneldev-mcp");
const VENV_DIR = path.resolve(KERNELDEV_MCP_DIR, ".venv");
const SETUP_CJS = path.resolve(PROJECT_ROOT, "scripts", "setup.cjs");
const GIT_URL = "https://github.com/josefbacik/kerneldev-mcp";

// ---------------------------------------------------------------------------
// Python interpreter / venv discovery
// ---------------------------------------------------------------------------

/**
 * Absolute system paths that are known to work with `python -m venv`.
 *
 * IMPORTANT: bare command names (e.g. `python3`) MUST NOT be used with
 * `python -m venv` inside this environment: `python3 -m venv` fails with
 * "Unable to determine path to the running Python interpreter", even
 * though `command -v python3` resolves to `/usr/bin/python3`. Only the
 * *absolute* interpreter path works reliably. This is also why LM Studio's
 * spawn (which cannot resolve bare `python3` in its restricted PATH) threw
 * `spawn python3 ENOENT` before the venv existed.
 */
const VENV_PYTHON_PATHS = [
  "/usr/bin/python3.14",
  "/usr/bin/python3.13",
  "/usr/bin/python3.12",
  "/usr/bin/python3.11",
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/homebrew/bin/python3",
];

/**
 * Find an interpreter that actually works with `python -m venv`.
 * Tries absolute paths first (robust against a restricted PATH).
 * Returns null if none work.
 */
function findVenvPython(): string | null {
  for (const candidate of VENV_PYTHON_PATHS) {
    if (!existsSync(candidate)) continue;
    try {
      execSync(`${candidate} -m venv --help`, {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
        timeout: 15000,
      });
      return candidate;
    } catch {
      /* not usable — try next */
    }
  }
  return null;
}

/**
 * Locate the Python interpreter inside the venv created by setup.cjs.
 * If the venv does NOT exist, try to (re)create it lazily (this handles
 * LM Studio Hub installs that skip the npm `postinstall` hook), then
 * fall back to absolute system Python paths.
 *
 * IMPORTANT: This function NEVER returns a bare command name (e.g. "python3").
 * It always returns an absolute path. This is critical because LM Studio's
 * subprocess spawn (used by the MCP SDK's StdioClientTransport) cannot resolve
 * bare command names in its restricted PATH. Returning a bare "python3" would
 * cause `spawn python3 ENOENT` at runtime.
 */
export function findPythonInterpreter(): string {
  // 1) Prefer the venv Python (has the required packages installed).
  const venvPython = path.join(KERNELDEV_MCP_DIR, ".venv", "bin", "python");
  if (existsSync(venvPython)) {
    return venvPython;
  }

  // 2) Lazy recreate: if `scripts/setup.cjs` was skipped (e.g. LM Studio
  //    Hub install does not run npm lifecycle hooks), try to recreate the
  //    venv now. This keeps the plugin working without manual steps.
  const recreated = ensureVenv();

  // 3) After (re)creation, prefer the venv Python again.
  if (recreated) {
    const venvPython2 = path.join(KERNELDEV_MCP_DIR, ".venv", "bin", "python");
    if (existsSync(venvPython2)) {
      return venvPython2;
    }
  }

  // 4) Last resort: use an absolute system Python path (robust against a
  //    restricted PATH inside LM Studio). NOTE: this only works if the
  //    venv was *not* created (i.e. setup.cjs and ensureVenv both failed
  //    to create a venv). A system python without the venv packages will
  //    usually fail at runtime — in that case run `node scripts/setup.cjs`.
  const sysPy = findVenvPython();
  if (sysPy) {
    return sysPy;
  }

  // Nothing left to try. Give the user a direct, actionable message.
  const hint = existsSync(KERNELDEV_MCP_DIR)
    ? `The kerneldev-mcp source tree exists at ${KERNELDEV_MCP_DIR} but no Python venv was found or created. Run \`node scripts/setup.cjs\` (or \`npm install\`) to create it.`
    : `The kerneldev-mcp source tree is missing. Run \`node scripts/setup.cjs\` (or \`npm install\`) to clone it and create the venv.`;
  throw new Error(
    "Could not locate a usable Python 3 interpreter or create a venv. " + hint,
  );
}

/**
 * Runtime fallback: install the core Python packages into an existing venv.
 * This mirrors the package-install step of `scripts/setup.cjs` so the
 * lightweight fallback can fully reproduce a working environment when
 * setup.cjs was skipped (e.g. LM Studio Hub install). Kept minimal: only
 * the MCP server's runtime dependencies.
 */
const VENV_PACKAGES = ["mcp>=0.9.0,<1.0", "pydantic>=2.0.0"];

function installVenvPackages(venvBin: string): boolean {
  const pip = path.join(venvBin, process.platform === "win32" ? "pip.exe" : "pip");
  const pythonBin = path.join(
    venvBin,
    process.platform === "win32" ? "python.exe" : "python",
  );
  if (!existsSync(pip)) {
    try {
      execSync(`${pythonBin} -m ensurepip --upgrade`, {
        cwd: KERNELDEV_MCP_DIR,
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      /* ensurepip unavailable — pip install will fail loudly later */
      return false;
    }
  }
  // Upgrade pip first.
  try {
    execSync(`${pip} install --upgrade pip`, {
      cwd: KERNELDEV_MCP_DIR,
      stdio: "pipe",
      timeout: 120000,
    });
  } catch {
    /* non-fatal — continue with existing pip */
  }
  // Install the runtime dependencies.
  for (const pkg of VENV_PACKAGES) {
    try {
      execSync(`${pip} install ${pkg}`, {
        cwd: KERNELDEV_MCP_DIR,
        stdio: "pipe",
        timeout: 180000,
      });
    } catch {
      return false;
    }
  }
  // Install kerneldev-mcp itself in editable mode.
  try {
    execSync(`${pip} install -e .`, {
      cwd: KERNELDEV_MCP_DIR,
      stdio: "pipe",
      timeout: 180000,
    });
  } catch {
    return false;
  }
  return true;
}

/**
 * Lazily create the Python venv + kerneldev-mcp source tree if it is
 * missing. This is a recovery path for when the npm `postinstall` hook
 * (scripts/setup.cjs) did not run — which is the case for plugins
 * installed from the LM Studio Hub.
 *
 * NOTE on timeouts: a full `setup.cjs` run (git clone + venv + pip install)
 * can take several minutes.  We therefore delegate to setup.cjs with a
 * generous timeout ONLY when the source tree is also missing (fresh clone
 * needed).  When only the venv is missing but the source tree exists, we do
 * a lightweight venv-only recreation (fast).  This keeps the common
 * "venv-only" recovery path snappy instead of re-cloning the repo.
 *
 * Returns true if a working venv (with packages installed) was produced,
 * false otherwise.
 */
export function ensureVenv(): boolean {
  if (existsSync(VENV_DIR)) {
    // Even if the venv exists, verify the packages are present; reinstall
    // them if a prior setup was partial/failed.
    const pip = path.join(
      VENV_DIR,
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "pip.exe" : "pip",
    );
    if (existsSync(pip)) {
      try {
        execSync(`${pip} show mcp >/dev/null 2>&1`, {
          cwd: KERNELDEV_MCP_DIR,
          stdio: "pipe",
          timeout: 15000,
        });
        return true; // packages already present
      } catch {
        /* packages missing — fall through to reinstall */
      }
    }
    const venvBin = path.join(
      VENV_DIR,
      process.platform === "win32" ? "Scripts" : "bin",
    );
    if (installVenvPackages(venvBin)) {
      return true;
    }
    return false;
  }

  // --- Fresh clone needed (kerneldev-mcp/ missing) ---
  // Delegate to the full setup.cjs (clone repo + create venv + install pkgs).
  // setup.cjs uses absolute Python paths and works regardless of cwd.
  // Redirect setup stdout to stderr so leftover setup logs never pollute the
  // MCP JSON-RPC stdout stream.
  if (existsSync(SETUP_CJS)) {
    try {
      execSync(`node "${SETUP_CJS}"`, {
        cwd: PROJECT_ROOT,
        stdio: ["pipe", "pipe", "inherit"],
        timeout: 300000,
      });
      if (existsSync(VENV_DIR)) {
        return true;
      }
    } catch {
      /* Fall through to the lightweight venv-only fallback below. */
    }
  }

  // --- Only the venv is missing (source tree exists) ---
  // Do a lightweight venv + package recreation.  Only ABSOLUTE interpreter
  // paths are used: `python3 -m venv` is unreliable in this environment
  // (see VENV_PYTHON_PATHS comment).
  if (existsSync(KERNELDEV_MCP_DIR)) {
    const py = findVenvPython();
    if (py) {
      try {
        execSync(`${py} -m venv --copies .venv`, {
          cwd: KERNELDEV_MCP_DIR,
          stdio: "pipe",
          timeout: 120000,
        });
        if (existsSync(VENV_DIR)) {
          const venvBin = path.join(
            VENV_DIR,
            process.platform === "win32" ? "Scripts" : "bin",
          );
          return installVenvPackages(venvBin);
        }
      } catch {
        /* clean up any partial directory so retries start fresh */
        try {
          execSync(`rm -rf "${VENV_DIR}"`, {
            cwd: KERNELDEV_MCP_DIR,
            stdio: "pipe",
          });
        } catch {
          /* ignore */
        }
      }
    }
  }

  // --- Fallback: try to clone kerneldev-mcp manually (in case setup.cjs
  // failed due to a transient issue) and then create the venv. ---
  if (!existsSync(KERNELDEV_MCP_DIR)) {
    try {
      execSync(`git clone ${GIT_URL} kerneldev-mcp`, {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
        timeout: 120000,
      });
      if (existsSync(KERNELDEV_MCP_DIR)) {
        // Now apply the compatibility patch and create the venv.
        const py2 = findVenvPython();
        if (py2) {
          try {
            execSync(`${py2} -m venv --copies .venv`, {
              cwd: KERNELDEV_MCP_DIR,
              stdio: "pipe",
              timeout: 120000,
            });
            if (existsSync(VENV_DIR)) {
              const venvBin = path.join(
                VENV_DIR,
                process.platform === "win32" ? "Scripts" : "bin",
              );
              return installVenvPackages(venvBin);
            }
          } catch {
            /* ignore — fall through to final failure */
          }
        }
      }
    } catch {
      /* git clone failed — fall through to final failure */
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// PythonMcpClient class
// ---------------------------------------------------------------------------

export interface IPythonMcpClient {
  /** List all tools exposed by the Python MCP server. */
  listTools(): Promise<Tool[]>;
  /** Call a tool by name with the given arguments. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Terminate the child process and clean up resources. */
  destroy(): Promise<void>;
}

export class PythonMcpClient implements IPythonMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private pythonPath: string;
  private kernelDevMcpPath: string;
  private toolsCache: Tool[] | null = null;

  constructor(
    pythonPath: string,
    kernelDevMcpPath: string,
  ) {
    this.pythonPath = pythonPath;
    this.kernelDevMcpPath = kernelDevMcpPath;
  }

  /** Initialize the client (spawns the Python subprocess). */
  async initialize(): Promise<void> {
    // Make the venv's bin directory available on PATH so the spawned
    // subprocess can locate `python`/`python3` if anything internally
    // references it by name (defensive, improves robustness).
    const venvBin = path.join(this.kernelDevMcpPath, ".venv", "bin");
    const basePath = process.env.PATH ?? "";
    const env = { ...process.env, PATH: `${venvBin}:${basePath}` };

    this.transport = new StdioClientTransport({
      command: this.pythonPath,
      args: ["-m", "kerneldev_mcp.server"],
      cwd: this.kernelDevMcpPath,
      stderr: "inherit", // forward Python logs to stderr (MCP rule: logs → stderr)
      env,
    });

    this.client = new Client(
      { name: "kerneldev-lms-mcp", version: "0.1.0" },
      // Tools are always supported in MCP. No additional capabilities needed.
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    // Cache the tool list for the lifetime of this client.
    this.toolsCache = null;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client) {
      throw new Error(
        "PythonMcpClient not initialized. Call initialize() before listTools().",
      );
    }

    if (!this.toolsCache) {
      const response = await this.client.listTools();
      this.toolsCache = response.tools;
    }
    return this.toolsCache;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client) {
      throw new Error(
        "PythonMcpClient not initialized. Call initialize() before callTool().",
      );
    }

    try {
      const response = await this.client.callTool({
        name,
        arguments: args,
      });

      // Build a human-readable text output from the MCP response content.
      let text = "";
      const contents = response.content as Array<{
        type: string;
        text?: string;
        resource?: { text?: string };
      }>;
      for (const content of contents) {
        if (content.type === "text" && content.text) {
          text += content.text;
        } else if (
          content.type === "resource" &&
          content.resource?.text
        ) {
          text += content.resource.text;
        } else {
          // For non-text content (image, audio, etc.), serialize minimally.
          text += `[${content.type} content]`;
        }
      }
      return text;
    } catch (error) {
      if (error instanceof McpError) {
        return `Error calling tool "${name}": ${error.message}`;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      return `Error calling tool "${name}": ${message}`;
    }
  }

  async destroy(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PythonMcpClient using auto-discovered paths.
 * The venv's Python interpreter is used if available; otherwise the
 * system Python is used as a fallback.
 */
export function createPythonMcpClient(): PythonMcpClient {
  const pythonPath = findPythonInterpreter();
  return new PythonMcpClient(pythonPath, KERNELDEV_MCP_DIR);
}
