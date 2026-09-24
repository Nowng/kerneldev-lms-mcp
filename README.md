# kerneldev-lms-mcp

**LM Studio Plugin** — a Linux kernel development configuration & build MCP
server, delivered as a lightweight TypeScript wrapper over the original
[kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp) project.

> [!NOTE]
> `kerneldev-lms-mcp` is **not** a rewrite of `kerneldev-mcp`. It is a
> compatibility layer that lets the original Python MCP server (which is
> *not* compatible with LM Studio on its own) run **inside** LM Studio as a
> first-class plugin. The original source tree is cloned at install time and
> kept as an untouched `git` clone so it can be updated later with `git pull`.

---

## What this project does

1. **Clones** the original [kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp)
   repository into `kerneldev-mcp/`.
2. **Creates a Python venv** (`kerneldev-mcp/.venv/`) and installs the
   runtime dependencies needed by the original server.
3. **Applies a small compatibility patch** (when needed) to fix a Python 3.13+
   `KernelConfig` scoping bug in the original `server.py`.
4. **Exposes all of kerneldev-mcp's MCP tools** to LM Studio (and to any MCP
   client) via a TypeScript wrapper that converts the Python JSON schemas into
   Zod schemas for validation and autocomplete.

The original `kerneldev-mcp` source tree is **never modified** by this wrapper.

---

## Installation

### Option A — Install from the LM Studio Hub (recommended)

1. Open LM Studio (v0.3.17+).
2. Go to the **Plugins** section and search for **`kerneldev-lms-mcp`** (by
   `hoonowng`).
3. Click **Install**.
4. The installer will:
   - run `npm install` (which triggers the `postinstall` hook),
   - run `scripts/setup.cjs` which clones `kerneldev-mcp`, creates the Python
     venv, and installs the Python packages,
   - build the TypeScript wrapper (`npm run build`).
5. Once installation finishes, the tools are available in your chat.

> [!TIP]
> After a Hub install, the first tool call may take a few seconds while the
> Python venv and packages are prepared. Subsequent calls are fast.

### Option B — Manual / local development install

```bash
# 1. Clone this plugin (the wrapper) — NOT the original kerneldev-mcp.
git clone https://github.com/hoonowng/kerneldev-lms-mcp.git
cd kerneldev-lms-mcp

# 2. Install Node dependencies AND run the postinstall setup (clone + venv + pip).
npm install

# 3. Build the TypeScript wrapper.
npm run build
```

`npm install` automatically runs `scripts/setup.cjs` (the `postinstall` hook).
If you ever need to re-run setup manually:

```bash
node scripts/setup.cjs
```

---

## LM Studio Plugin usage

Once installed, the kerneldev-mcp tools appear automatically in your LM Studio
chat. Select a tool from the tool palette (or let the model call it) and provide
the required arguments. No further configuration is needed.

The plugin registers **39 tools**, grouped as follows:

### Kernel configuration

| Tool | Description |
|------|-------------|
| `list_config_presets` | List all available kernel configuration presets (by target/debug/fragment). |
| `get_config_template` | Generate a complete kernel configuration from templates (boot, btrfs, filesystem, networking, virtualization). |
| `create_config_fragment` | Create a custom configuration fragment. |
| `merge_configs` | Merge multiple configuration fragments. |
| `apply_config` | Apply a configuration to a kernel source tree (supports cross-compilation, LLVM, virtme). |
| `validate_config` | Validate a kernel `.config` file against a kernel source tree. |
| `modify_kernel_config` | Enable, disable, or modify specific `CONFIG_*` options in an existing `.config`. |
| `search_config_options` | Search kernel configuration options by query and category. |

### Build management

| Tool | Description |
|------|-------------|
| `generate_build_config` | Generate an optimized build configuration and commands (speed/debug/size, ccache, out-of-tree). |
| `build_kernel` | Build the Linux kernel and validate the build (all, vmlinux, modules, bzImage, Image, dtbs). |
| `check_build_requirements` | Check whether a kernel source tree is ready to build. |
| `clean_kernel_build` | Clean kernel build artifacts (clean, mrproper, distclean). |

### VM boot & testing (virtme-ng)

| Tool | Description |
|------|-------------|
| `boot_kernel_test` | Boot a kernel with virtme-ng and test it (optional custom commands/scripts, dmesg validation). |
| `check_virtme_ng` | Check whether virtme-ng is installed and available. |
| `kill_hanging_vms` | Kill VM processes hung by this kerneldev-mcp session. |

### fstests integration

| Tool | Description |
|------|-------------|
| `fstests_setup_check` | Step 1: check whether fstests is installed. |
| `fstests_check_environment` | Comprehensive fstests environment check (installation, kernel config, devices, virtme). |
| `fstests_setup_install` | Step 2: clone and build fstests from git. |
| `fstests_setup_devices` | Step 3: create test and scratch block devices. |
| `fstests_setup_configure` | Step 4: create/update `local.config`. |
| `fstests_vm_boot_and_run` | All-in-one: boot a kernel in a VM, set up fstests, and run tests. |
| `fstests_vm_boot_custom` | Boot a kernel in a VM with a fstests device environment and run a custom command/script. |
| `fstests_groups_list` | List available fstests test groups (quick, auto, dangerous, log, metadata). |

### fstests baselines & git integration

| Tool | Description |
|------|-------------|
| `fstests_baseline_get` | Retrieve a stored baseline (previous test results). |
| `fstests_baseline_compare` | Compare current results against a baseline to detect regressions. |
| `fstests_baseline_list` | List all stored baselines with metadata. |
| `fstests_baseline_save` | Save test results as a baseline (and/or to git notes). |
| `fstests_git_load` | Load fstests results from git notes. |
| `fstests_git_list` | List commits that have stored fstests results. |
| `fstests_git_delete` | Delete fstests results from git notes. |

### mmtests (memory-management selftests)

| Tool | Description |
|------|-------------|
| `mmtests_vm_boot_and_run` | Boot a kernel in a 2-node NUMA VM and run mm selftests (ksm, thp, …). |
| `mmtests_host_build_and_run` | Build and run host-side mm userspace tests (radix-tree, vma, memblock) without a VM. |

### LVM device pool (for fstests)

| Tool | Description |
|------|-------------|
| `device_pool_setup` | Create an LVM-based device pool (PV + VG). |
| `device_pool_status` | Display and validate device pool health. |
| `device_pool_teardown` | Remove a device pool and clean up resources. |
| `device_pool_resize` | Resize a logical volume by its full LV name. |
| `device_pool_snapshot` | Create/delete LVM snapshots. |
| `device_pool_list` | List all configured device pools. |
| `device_pool_cleanup` | Clean up orphaned LVs from dead MCP processes. |

---

## Porting summary (what was done)

The original [kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp) is a
Python MCP server that uses the **legacy lowlevel MCP API** (`Server` class and
`@app.list_tools()` / `@app.call_tool()` decorator handlers). That API was
removed in `mcp` 1.0, and the original project pins `mcp>=0.9.0` (no upper
bound), so pip would install a 1.x `mcp` that breaks the original server.
`kerneldev-mcp` is therefore **incompatible with LM Studio** as-is.

This port (`kerneldev-lms-mcp`) solves the problem with a **lightweight
TypeScript wrapper** and a **Python venv**, keeping the original source tree
100% untouched:

1. **TypeScript wrapper** (`src/`): a thin layer that
   - clones the original repo at install time (never at request time),
   - creates and maintains an isolated Python venv,
   - discovers all MCP tools from the Python server at startup (including
     dynamically generated ones like `device_pool_*`),
   - converts each tool's JSON schema to a Zod schema for LM Studio
     validation/autocomplete,
   - forwards tool calls to the Python subprocess over stdio.
2. **`scripts/setup.cjs`** (npm `postinstall`): clones
   [kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp), creates the
   Python venv, installs pinned runtime packages (`mcp>=0.9.0,<1.0`,
   `pydantic>=2.0.0`), and installs the original package in editable mode — all
   with robust, absolute-path Python detection so it works even inside LM
   Studio's restricted Node.js environment.
3. **Runtime fallback** (`src/core/pythonMcpClient.ts`): if the venv is ever
   missing (e.g. a Hub install that skips npm lifecycle hooks), `ensureVenv()`
   recreates it automatically — first by delegating to `setup.cjs`, then by a
   lightweight venv-only path if only the venv is missing, and finally by
   attempting a fresh `git clone` of the original repository. The
   `findPythonInterpreter()` function always returns an **absolute path** —
   it never returns a bare command name like `python3`, which would fail with
   `spawn python3 ENOENT` in LM Studio's restricted Node.js environment.
4. **Compatibility patch** (`scripts/fix-kernelconfig-scope.patch`): when the
   cloned original `server.py` still has the Python 3.13+ `KernelConfig`
   scoping bug, this patch is applied automatically at install time.

**Key design decisions:**
- The original `kerneldev-mcp` source tree is a **git clone**, never modified.
  Update it later with `git pull` inside `kerneldev-mcp/`.
- `mcp` is pinned to `<1.0` to preserve the legacy lowlevel API the original
  server relies on.
- The venv's `bin` directory is placed on `PATH` for spawned subprocesses so
  the `python3` reference inside the Python MCP server resolves correctly.
- This plugin is **LM Studio Plugin only** — the standalone MCP server entry
  point (`src/mcp.ts`) was removed to simplify the deployment surface and avoid
  issues with LM Studio's Hub installer. The plugin registers its tools via the
  `@lmstudio/sdk` `toolsProvider` API and communicates with the Python MCP
  server over stdio using the MCP SDK's `StdioClientTransport`.

---

## Acknowledgements

This project would not exist without the original
[kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp) project by
**josefbacik** and contributors, which provided the excellent Python MCP server
and the full set of Linux kernel configuration, build, testing, and fstests
tools that this plugin exposes to LM Studio. We are grateful for their work
and for releasing it under the GPL-2.0 license.

---

## License

This project (the TypeScript wrapper, `scripts/setup.cjs`, and the compatibility
patch) is licensed under the **GNU General Public License v2.0 (GPL-2.0)**,
consistent with the license of the original
[kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp) project.

The original [kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp)
source tree — which is cloned at install time and kept unmodified — remains
licensed under its original **GPL-2.0** license. See the original project for
full license details.
