/**
 * Post-installation setup script for kerneldev-lms-mcp.
 *
 * This script is executed automatically by `npm install` (via the
 * "postinstall" hook in package.json) when the LM Studio plugin is
 * installed. It performs the following steps:
 *
 *   [a] Clones the original kerneldev-mcp repository into the
 *       `kerneldev-mcp/` directory (kept as a git clone so it can be
 *       updated later with `git pull`).
 *   [b] Creates a Python venv environment inside
 *       `kerneldev-mcp/.venv/`.
 *   [c] Installs the required Python packages into the venv.
 *
 * The original kerneldev-mcp source tree is NEVER modified by this
 * wrapper. All Python dependencies are installed into the isolated
 * venv, keeping the host system clean.
 *
 * NOTE on LM Studio Hub installations:
 *   LM Studio's Hub installer does NOT run npm lifecycle scripts
 *   (like "postinstall"). Therefore this script may not run when the
 *   plugin is installed from the Hub. The TypeScript wrapper
 *   (src/core/pythonMcpClient.ts) includes a lazy runtime fallback
 *   (ensureVenv) that recreates the venv if it is missing. If BOTH
 *   this script AND the runtime fallback are skipped/failed, you can
 *   run the setup manually:
 *
 *     cd <plugin-root>
 *     npm install            # runs this postinstall hook
 *     # or, equivalently:
 *     node scripts/setup.cjs
 */

const { execSync, spawnSync } = require("child_process");
const { existsSync, writeFileSync } = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Resolve the *actual* project root on disk. __dirname is the `scripts/`
// directory, so the project root is one level up. We use absolute paths
// everywhere so the script works regardless of the current working
// directory (important because LM Studio / npm may invoke it from
// different cwd locations).
const SCRIPT_DIR = __dirname;
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const KERNELDEV_MCP_DIR = path.resolve(PROJECT_DIR, "kerneldev-mcp");
const VENV_DIR = path.resolve(KERNELDEV_MCP_DIR, ".venv");
const GIT_URL = "https://github.com/josefbacik/kerneldev-mcp";
const DIAG_LOG = path.resolve(PROJECT_DIR, ".lmstudio", "setup-diagnostic.log");

// Only the runtime dependencies declared in the original project's
// pyproject.toml are needed. Dev dependencies (pytest, black, mypy, ...)
// are NOT required at runtime.
//
// NOTE: The original kerneldev-mcp server.py uses the legacy lowlevel
// `Server` class with decorator-based handlers (@app.list_tools(),
// @app.call_tool(), etc.). This API was removed in mcp v2.0. We pin to
// <2.0 to maintain compatibility with the original source tree, which we
// must NOT modify per the project's porting requirements.
const PYTHON_PACKAGES = [
  // The original kerneldev-mcp server.py uses the legacy lowlevel MCP API
  // (decorator-based handlers @app.list_tools() / @app.call_tool() and the
  // lowlevel Server class).  That API was removed in mcp 1.0.  We therefore
  // pin to <1.0 to stay on the last 0.x line that the UNMODIFIED original
  // source tree is compatible with.  (The original pyproject.toml lists
  // "mcp>=0.9.0" with no upper bound, so without this pin pip would install
  // mcp 1.x and the MCP tools would fail at runtime.)
  "mcp>=0.9.0,<1.0",
  "pydantic>=2.0.0",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append a timestamped line to a diagnostic log file (always, even on success). */
function diag(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    const logDir = path.dirname(DIAG_LOG);
    if (!existsSync(logDir)) {
      try {
        writeFileSync(logDir, "");
      } catch {
        /* ignore */
      }
      try {
        require("fs").mkdirSync(logDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
    writeFileSync(DIAG_LOG, line + "\n", { flag: "a" });
  } catch {
    /* best effort — never throw on log write failures */
  }
}

/**
 * Run a command through the shell (for commands that need shell
 * interpretation, e.g. git clone, where, command -v).
 */
function runShell(cmd, opts = {}) {
  diag(`RUN(shell): ${cmd}`);
  return execSync(cmd, { cwd: PROJECT_DIR, stdio: "pipe", ...opts });
}

/**
 * Run a command directly (no shell) using spawnSync with array args.
 * This avoids shell interpretation of characters like < and >.
 */
function runDirect(cmd, args, opts = {}) {
  diag(`RUN(direct): ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")} (exit code ${result.status})`,
    );
  }
}

/**
 * Find a usable Python 3 interpreter.
 *
 * We try full paths FIRST (in case the runner's PATH is restricted, as
 * is the case inside LM Studio), then fall back to PATH lookups.
 * Each candidate is verified by actually importing sys.
 */
function findPythonExecutable() {
  const seen = new Set();

  /** Register a candidate from an absolute path. */
  function addFull(p) {
    if (!p || seen.has(p)) return null;
    seen.add(p);
    if (!existsSync(p)) return null;
    let ok = false;
    try {
      runDirect(p, ["-c", "import sys; sys.exit(0)"], {
        cwd: PROJECT_DIR,
        stdio: "pipe",
      });
      ok = true;
    } catch {
      /* not usable — try next */
    }
    if (ok) {
      return p;
    }
    return null;
  }

  /** Register a candidate by command name (uses PATH). */
  function addName(name) {
    if (seen.has(name)) return null;
    seen.add(name);
    let cmd = "";
    try {
      if (process.platform === "win32") {
        cmd = `where ${name}`;
      } else {
        cmd = `command -v ${name}`;
      }
      const result = runShell(cmd, { stdio: "pipe" }).toString().trim();
      if (!result) return null;
      // `where` may return many lines; take the first usable one.
      const candidates = result.split(/\r?\n/).filter(Boolean);
      for (const c of candidates) {
        const found = addFull(c);
        if (found) return found;
      }
    } catch {
      /* not found — try next */
    }
    return null;
  }

  // 1) Full paths (robust against restricted PATH, e.g. LM Studio).
  const fullCandidates = [
    "/usr/bin/python3.14",
    "/usr/bin/python3.13",
    "/usr/bin/python3.12",
    "/usr/bin/python3.11",
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/homebrew/bin/python3",
  ];
  for (const c of fullCandidates) {
    const found = addFull(c);
    if (found) return found;
  }

  // 2) PATH-based command names.
  const nameCandidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const name of nameCandidates) {
    const found = addName(name);
    if (found) return found;
  }

  throw new Error(
    "Cannot find a Python 3 interpreter. Please install Python 3.11+ " +
    "(e.g. `apt install python3` / `dnf install python3`).",
  );
}

// ---------------------------------------------------------------------------
// [a] Clone the original kerneldev-mcp repository
// ---------------------------------------------------------------------------

if (existsSync(KERNELDEV_MCP_DIR)) {
  console.log("[setup] kerneldev-mcp directory already exists — skipping git clone.");
  diag("SKIP clone: kerneldev-mcp dir already exists");
} else {
  console.log("[setup] Cloning original kerneldev-mcp repository...");
  diag("START clone");
  try {
    runShell(`git clone ${GIT_URL} kerneldev-mcp`);
    console.log("[setup] Git clone completed successfully.");
    diag("OK clone");
  } catch (err) {
    console.error(`[setup] ERROR: git clone failed: ${err.message}`);
    diag(`FAIL clone: ${err.message}`);
    throw new Error(
      "Failed to clone the original kerneldev-mcp repository. " +
      "Check your internet connection and try `git clone https://github.com/josefbacik/kerneldev-mcp` manually.",
    );
  }
}

// ---------------------------------------------------------------------------
// [d] Apply compatibility patch for Python 3.13+ KernelConfig scoping bug
// ---------------------------------------------------------------------------
//
// The original kerneldev-mcp/server.py has a bug where a local import of
// `KernelConfig` inside the `mmtests_vm_boot_and_run` handler (within the
// `call_tool` async function) creates a local variable that shadows the
// module-level import. Python 3.13+ detects this as accessing a local
// variable before assignment, causing:
//
//   Error: cannot access local variable 'KernelConfig' where it is not
//          associated with a value
//
// This affects `create_config_fragment` and `validate_config` tools.
// The patch removes the redundant local import since `KernelConfig` is
// already imported at the module level.
//
// The patch is applied ONLY if the issue still exists in the cloned source,
// ensuring compatibility with both old and new versions of kerneldev-mcp.

function applyCompatibilityPatch() {
  const serverPyPath = path.resolve(
    KERNELDEV_MCP_DIR,
    "src",
    "kerneldev_mcp",
    "server.py",
  );
  const patchPath = path.resolve(SCRIPT_DIR, "fix-kernelconfig-scope.patch");

  if (!existsSync(serverPyPath)) {
    diag("SKIP patch: server.py not found");
    console.log("[setup] server.py not found — skipping compatibility patch.");
    return;
  }

  let serverPyContent;
  try {
    serverPyContent = require("fs").readFileSync(serverPyPath, "utf-8");
  } catch {
    diag("SKIP patch: could not read server.py");
    console.log("[setup] Could not read server.py — skipping compatibility patch.");
    return;
  }

  // The issue exists if both of these patterns are present:
  // 1. Module-level import of KernelConfig (already fixed upstream in some versions)
  // 2. Local import of KernelConfig inside call_tool function
  const hasModuleLevelImport =
    /from \.config_manager import .*KernelConfig/.test(serverPyContent);
  const hasLocalImportInCallTool =
    /async def call_tool[\s\S]*?from \.config_manager import KernelConfig/.test(
      serverPyContent,
    );

  if (!hasModuleLevelImport || !hasLocalImportInCallTool) {
    diag("SKIP patch: KernelConfig scoping issue not detected");
    console.log(
      "[setup] KernelConfig scoping issue not detected — skipping compatibility patch.",
    );
    return;
  }

  console.log("[setup] KernelConfig scoping issue detected — applying compatibility patch...");
  diag("START patch");

  if (!existsSync(patchPath)) {
    console.error(
      `[setup] ERROR: Patch file not found at ${patchPath}. ` +
      `create_config_fragment and validate_config tools may not work on Python 3.13+.`,
    );
    diag(`FAIL patch: patch file missing`);
    return;
  }

  try {
    runShell(`git apply ${patchPath}`, { cwd: KERNELDEV_MCP_DIR });
    console.log("[setup] Compatibility patch applied successfully.");
    diag("OK patch");
  } catch (err) {
    console.error(`[setup] ERROR: Failed to apply patch: ${err.message}`);
    diag(`FAIL patch: ${err.message}`);
    console.log(
      "[setup] The create_config_fragment and validate_config tools may not work on Python 3.13+.",
    );
  }
}

applyCompatibilityPatch();

// ---------------------------------------------------------------------------
// [b] Create a Python venv environment
// ---------------------------------------------------------------------------

const pythonBin = findPythonExecutable();
diag(`Using python: ${pythonBin}`);

if (existsSync(VENV_DIR)) {
  console.log("[setup] Python venv already exists — skipping venv creation.");
  diag("SKIP venv: already exists");
} else {
  console.log(`[setup] Creating Python venv at ${VENV_DIR}...`);
  diag("START venv");
  try {
    // Use --copies to avoid issues with venv not finding the Python
    // interpreter when run as a subprocess (e.g., in LM Studio's
    // Node.js environment). Timeout guarded at 120s.
    const start = Date.now();
    runShell(`${pythonBin} -m venv --copies .venv`, {
      cwd: KERNELDEV_MCP_DIR,
      timeout: 120000,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[setup] Python venv created in ${elapsed}s.`);
    diag(`OK venv (${elapsed}s)`);
  } catch (err) {
    console.error(`[setup] ERROR: venv creation failed: ${err.message}`);
    diag(`FAIL venv: ${err.message}`);
    throw new Error(
      "Failed to create the Python venv. Ensure python3 -m venv works " +
      "(e.g. `apt install python3-venv`).",
    );
  }
}

// ---------------------------------------------------------------------------
// [c] Install required Python packages into the venv
// ---------------------------------------------------------------------------

const pipCmd =
  process.platform === "win32"
    ? path.resolve(VENV_DIR, "Scripts", "pip.exe")
    : path.resolve(VENV_DIR, "bin", "pip");

const pythonCmd =
  process.platform === "win32"
    ? path.resolve(VENV_DIR, "Scripts", "python.exe")
    : path.resolve(VENV_DIR, "bin", "python");

// Ensure pip is available (some minimal venvs skip it).
if (!existsSync(pipCmd)) {
  console.log("[setup] Ensuring pip is available in venv (ensurepip)...");
  diag("START ensurepip");
  try {
    runDirect(pythonCmd, ["-m", "ensurepip", "--upgrade"], {
      cwd: KERNELDEV_MCP_DIR,
      timeout: 60000,
    });
    diag("OK ensurepip");
  } catch (err) {
    console.error(`[setup] WARNING: ensurepip failed: ${err.message}`);
    diag(`WARN ensurepip: ${err.message}`);
    // Continue — we will try pip install and let it fail loudly if pip
    // is truly missing.
  }
}

console.log("[setup] Upgrading pip inside venv...");
diag("START pip upgrade");
try {
  runDirect(pipCmd, ["install", "--upgrade", "pip"], {
    cwd: KERNELDEV_MCP_DIR,
    timeout: 120000,
  });
  diag("OK pip upgrade");
} catch (err) {
  console.error(`[setup] WARNING: pip upgrade failed: ${err.message}`);
  diag(`WARN pip upgrade: ${err.message}`);
}

// Install the runtime dependencies.
// NOTE: We use runDirect (spawnSync with array args) to avoid shell
// interpretation of < and > characters in version specifiers like
// "mcp>=0.9.0,<1.0".
for (const pkg of PYTHON_PACKAGES) {
  console.log(`[setup] Installing Python package: ${pkg}`);
  diag(`START pip install: ${pkg}`);
  try {
    runDirect(pipCmd, ["install", pkg], {
      cwd: KERNELDEV_MCP_DIR,
      timeout: 180000,
    });
    diag(`OK pip install: ${pkg}`);
  } catch (err) {
    console.error(`[setup] ERROR: pip install failed for ${pkg}: ${err.message}`);
    diag(`FAIL pip install: ${pkg}: ${err.message}`);
    throw new Error(
      `Failed to install Python package "${pkg}". ` +
      `Check your internet connection or install it manually: ` +
      `${pythonCmd} -m pip install ${pkg}`,
    );
  }
}

// Install the original kerneldev-mcp package in development mode so that
// `python -m kerneldev_mcp.server` works without modifying the source tree.
console.log("[setup] Installing kerneldev-mcp in development mode...");
diag("START pip install -e .");
try {
  runDirect(pipCmd, ["install", "-e", "."], {
    cwd: KERNELDEV_MCP_DIR,
    timeout: 180000,
  });
  diag("OK pip install -e .");
} catch (err) {
  console.error(
    `[setup] ERROR: editable install failed: ${err.message}`,
  );
  diag(`FAIL pip install -e .: ${err.message}`);
  throw new Error(
    `Failed to install kerneldev-mcp in development mode. ` +
    `You can install it manually inside the venv: ` +
    `${pythonCmd} -m pip install -e .`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log("[setup] ========================================");
console.log("[setup] Setup complete.");
console.log(`[setup]   - kerneldev-mcp source:  ${KERNELDEV_MCP_DIR}`);
console.log(`[setup]   - python venv:          ${VENV_DIR}`);
console.log(`[setup]   - python executable:    ${pythonCmd}`);
console.log("[setup] ========================================");
console.log("");
console.log("[setup] To use the Python MCP tools manually:");
console.log(`  ${pythonCmd} -m kerneldev_mcp.server`);
console.log("");
diag("OK complete");
