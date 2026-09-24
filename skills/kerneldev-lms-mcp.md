# kerneldev-lms-mcp — Skill Guide for LLMs

This guide teaches an LLM how to use the **kerneldev-lms-mcp** tools. These
tools manage Linux kernel configuration and builds. They come from the original
[kerneldev-mcp](https://github.com/josefbacik/kerneldev-mcp) project and are
exposed here through an LM Studio plugin.

- **Number of tools:** 39
- **How they work:** Each tool is a function the LLM can call. The tool runs a
  Python MCP server (the original `kerneldev-mcp`) under the hood. The LLM
  only calls the tool with the right arguments.
- **Language:** English
- **Target model:** Small LLMs (4B parameters). Keep prompts short and clear.

---

## 1. MCP Tool Interface Definition

Every tool has a **name**, a **description**, and an **input schema** (its
arguments). The LLM must pass arguments that match the schema.

### Common argument patterns used across many tools

| Argument | Type | Meaning |
|----------|------|---------|
| `kernel_path` | string | Path to the Linux kernel source tree on disk (e.g. `/home/user/linux`). |
| `config_path` | string | Path to a kernel `.config` file. |
| `target` | string | Build target: `all`, `vmlinux`, `modules`, `bzImage`, `Image`, `dtbs`. |
| `cross_compile_arch` | string | Architecture for cross-compilation: `x86_64`, `x86`, `arm64`, `arm`, `riscv`, `powerpc`, `mips`. |
| `cross_compile_prefix` | string | Cross-compiler prefix (e.g. `aarch64-linux-gnu-`). |
| `use_llvm` | boolean | Use LLVM/Clang instead of GCC. |
| `timeout` | integer | Maximum seconds to wait for the tool to finish. |
| `clean_type` | string | Cleanup level: `clean`, `mrproper`, `distclean`. |

### Tool groups (39 tools total)

**A. Configuration tools (8)**
`list_config_presets`, `get_config_template`, `create_config_fragment`,
`merge_configs`, `apply_config`, `validate_config`, `modify_kernel_config`,
`search_config_options`

**B. Build tools (4)**
`generate_build_config`, `build_kernel`, `check_build_requirements`,
`clean_kernel_build`

**C. VM boot & test tools (3)**
`boot_kernel_test`, `check_virtme_ng`, `kill_hanging_vms`

**D. fstests tools (13)**
`fstests_setup_check`, `fstests_check_environment`, `fstests_setup_install`,
`fstests_setup_devices`, `fstests_setup_configure`, `fstests_vm_boot_and_run`,
`fstests_vm_boot_custom`, `fstests_groups_list`, `fstests_baseline_get`,
`fstests_baseline_compare`, `fstests_baseline_list`, `fstests_baseline_save`,
`fstests_git_load`, `fstests_git_list`, `fstests_git_delete`

**E. mmtests tools (2)**
`mmtests_vm_boot_and_run`, `mmtests_host_build_and_run`

**F. Device pool tools (7)**
`device_pool_setup`, `device_pool_status`, `device_pool_teardown`,
`device_pool_resize`, `device_pool_snapshot`, `device_pool_list`,
`device_pool_cleanup`

---

## 2. Usage Rules (Follow These)

1. **Always check the kernel source exists.** Before most tools, make sure
   `kernel_path` points to a real kernel tree. Use `check_build_requirements`
   first to verify it.
2. **Read the schema before calling.** Each tool lists required arguments
   (`required: [...]`). Do not omit required arguments.
3. **Respect timeouts.** Long tools (builds, VM tests) need large `timeout`
   values (60–600 seconds). Short tools need small values.
4. **One tool at a time.** Wait for the result of a tool call before calling the
   next one. Do not chain dependent tools in one message.
5. **Use the right architecture.** Set `cross_compile_arch` and
   `cross_compile_prefix` together when cross-compiling.
6. **Clean up VMs.** If a VM test hangs, call `kill_hanging_vms` afterward.
7. **fstests workflow order.** Follow the fixed order:
   `fstests_setup_check` → `fstests_setup_install` →
   `fstests_setup_devices` → `fstests_setup_configure` → run tests.
   Or use the all-in-one `fstests_vm_boot_and_run` instead.
8. **Baselines for regression.** To compare results across kernel versions:
   save a baseline with `fstests_baseline_save`, then compare with
   `fstests_baseline_compare`.
9. **Keep paths absolute.** Always pass absolute paths for `kernel_path`,
   `config_path`, and file arguments.
10. **Report errors clearly.** If a tool fails, read the error message and
    adjust one argument at a time. Do not retry the same failing call blindly.

---

## 3. Usage Examples

### Example 1 — List available configuration presets

```
Tool: list_config_presets
Arguments: { "category": "target" }
```

Returns a list of preset configurations (e.g. `boot`, `btrfs`, `filesystem`)
with descriptions.

### Example 2 — Generate a full kernel config from a template

```
Tool: get_config_template
Arguments: {
  "target": "boot",
  "debug_level": "basic",
  "architecture": "x86_64"
}
```

Returns a complete `.config` text for a minimal boot kernel.

### Example 3 — Create a custom config fragment

```
Tool: create_config_fragment
Arguments: {
  "name": "my-debug-fragment",
  "description": "Enable KASAN for memory error detection",
  "options": {
    "CONFIG_KASAN": "y",
    "CONFIG_KASAN_INLINE": "n"
  }
}
```

Returns a fragment file content that can be merged into a base config.

### Example 4 — Merge fragments into a final config

```
Tool: merge_configs
Arguments: {
  "base": "/home/user/.config/linux/.config",
  "fragments": ["my-debug-fragment.conf", "kasan.conf"],
  "output": "/home/user/.config/linux/my-config"
}
```

### Example 5 — Validate a kernel config against a kernel tree

```
Tool: validate_config
Arguments: {
  "config_path": "/home/user/.config/linux/my-config",
  "kernel_path": "/home/user/linux"
}
```

### Example 6 — Apply a config to a kernel source tree

```
Tool: apply_config
Arguments: {
  "kernel_path": "/home/user/linux",
  "config_source": "/home/user/.config/linux/my-config",
  "merge_with_existing": true,
  "cross_compile_arch": "arm64",
  "cross_compile_prefix": "aarch64-linux-gnu-",
  "use_llvm": false,
  "enable_virtme": true
}
```

### Example 7 — Search kernel config options

```
Tool: search_config_options
Arguments: {
  "query": "KASAN",
  "category": "debugging"
}
```

### Example 8 — Check build requirements before building

```
Tool: check_build_requirements
Arguments: {
  "kernel_path": "/home/user/linux"
}
```

### Example 9 — Build the kernel

```
Tool: build_kernel
Arguments: {
  "kernel_path": "/home/user/linux",
  "target": "all",
  "jobs": 8,
  "verbose": false,
  "keep_going": true,
  "timeout": 600,
  "clean_first": false
}
```

### Example 10 — Generate an optimized build config

```
Tool: generate_build_config
Arguments: {
  "target": "bzImage",
  "optimization": "speed",
  "ccache": true,
  "out_of_tree": true,
  "kernel_path": "/home/user/linux"
}
```

### Example 11 — Boot and test a kernel in a VM

```
Tool: boot_kernel_test
Arguments: {
  "kernel_path": "/home/user/linux",
  "command": "dmesg | tail -n 20",
  "timeout": 120,
  "memory": "4G",
  "cpus": 4
}
```

### Example 12 — Run fstests all-in-one in a VM

```
Tool: fstests_vm_boot_and_run
Arguments: {
  "kernel_path": "/home/user/linux",
  "fstests_path": "/home/user/fstests",
  "tests": ["-g", "quick"],
  "fstype": "ext4",
  "timeout": 300,
  "memory": "4G",
  "cpus": 4
}
```

### Example 13 — Save and compare test baselines (regression check)

```
# Step 1: save current results as a baseline
Tool: fstests_baseline_save
Arguments: {
  "results_dir": "/home/user/.kerneldev-mcp/fstests-results/run-1234/",
  "save_baseline": true,
  "baseline_name": "mainline-v6.1"
}

# Step 2: after a new kernel run, compare against the baseline
Tool: fstests_baseline_compare
Arguments: {
  "baseline_name": "mainline-v6.1",
  "kernel_path": "/home/user/linux",
  "branch_name": "my-fix-branch"
}
```

---

## 4. Practical Scenarios

### Scenario A — Plan and schedule a kernel config & build task

**Goal:** Configure a kernel, build it, and report the result.

Steps for the LLM:
1. Ask the user what kind of kernel they need (boot, filesystem, networking,
   virtualization) and the target architecture.
2. Call `get_config_template` with that target and architecture.
3. Call `validate_config` to confirm the generated config is valid.
4. Call `apply_config` to apply it to the kernel source tree.
5. Call `check_build_requirements` to confirm the tree is ready.
6. Call `generate_build_config` for an optimized build plan.
7. Call `build_kernel` with a generous timeout.
8. Summarize: build target, architecture, number of jobs, success/failure, and
   location of the resulting image.

### Scenario B — Manage a kernel configuration workspace

**Goal:** Keep multiple kernel configs organized and track which one is active.

Steps for the LLM:
1. Use `list_config_presets` to show available presets.
2. Use `create_config_fragment` to build custom fragments.
3. Use `merge_configs` to combine a base preset with custom fragments.
4. Use `validate_config` after each merge.
5. Use `modify_kernel_config` to toggle individual `CONFIG_*` options.
6. Keep a log (in chat) of which config file corresponds to which purpose.

### Scenario C — Run a regression test campaign (fstests)

**Goal:** Test a filesystem fix across multiple kernel versions.

Steps for the LLM:
1. For each kernel version, call `fstests_vm_boot_and_run` with the same
   test group (e.g. `["-g", "auto"]`).
2. After each run, call `fstests_baseline_save` to record the result.
3. After all runs, call `fstests_baseline_compare` between versions to find
   regressions (new failures) and improvements.
4. Summarize: which tests failed, which passed, and the diff between versions.

### Scenario D — Diagnose a build failure

**Goal:** Find out why a kernel build failed and fix it.

Steps for the LLM:
1. Call `check_build_requirements` to verify the kernel tree and tools.
2. Call `build_kernel` with `verbose: true` and `keep_going: false`.
3. Read the error output. Common causes:
   - Missing build dependencies → report the missing package.
   - Wrong `cross_compile_arch`/`cross_compile_prefix` mismatch → correct both.
   - Config invalid → re-run `validate_config` and fix the `.config`.
4. Retry with one fix at a time. Do not change multiple arguments at once.
5. Summarize the root cause and the fix applied.

### Scenario E — Summarize kernel config and build status for a report

**Goal:** Produce a human-readable report.

Steps for the LLM:
1. Call `list_config_presets` (category=`target`) to list available presets.
2. Call `get_config_template` for the chosen target to show the resulting
   configuration summary.
3. Call `generate_build_config` to show the optimized build plan.
4. Call `check_build_requirements` to confirm readiness.
5. Compile all results into a short report: kernel version, architecture,
   config preset, build options, expected output image, and readiness status.

### Scenario F — Manage device pools for multi-device fstests

**Goal:** Prepare LVM device pools for RAID/filesystem tests.

Steps for the LLM:
1. Call `device_pool_setup` with a disk path to create a PV + VG.
2. Call `device_pool_status` to verify health.
3. Use `fstests_setup_devices` (mode=`existing`) pointing at the pool.
4. After testing, call `device_pool_teardown` to clean up.
5. Use `device_pool_list` to confirm cleanup.

---

## 5. Quick Reference — Tool Name → Best Use

| Tool name | Best used for |
|-----------|---------------|
| `list_config_presets` | Discovering config options. |
| `get_config_template` | Generating a full `.config` from a preset. |
| `create_config_fragment` | Building small, reusable config snippets. |
| `merge_configs` | Combining a base config with fragments. |
| `apply_config` | Writing a config into a kernel tree. |
| `validate_config` | Checking a `.config` before building. |
| `modify_kernel_config` | Toggling individual CONFIG options. |
| `search_config_options` | Finding what a CONFIG option does. |
| `generate_build_config` | Planning an optimized build. |
| `build_kernel` | Compiling the kernel. |
| `check_build_requirements` | Verifying the tree is build-ready. |
| `clean_kernel_build` | Removing build artifacts. |
| `boot_kernel_test` | Quick VM boot validation. |
| `check_virtme_ng` | Verifying virtme-ng availability. |
| `kill_hanging_vms` | Recovering from a hung VM. |
| `fstests_*` | End-to-end filesystem testing workflow. |
| `fstests_vm_boot_and_run` | Fastest way to run fstests in a VM. |
| `fstests_baseline_*` | Saving and comparing test results across versions. |
| `mmtests_*` | Running memory-management selftests. |
| `device_pool_*` | Managing LVM device pools for fstests. |

---

## 6. Reminders for Small Models

- **Think step by step.** One tool call per message. Wait for the result.
- **Read the error.** If a call fails, the error message tells you what to
  change. Change only one thing and retry.
- **Use absolute paths.** Always pass full paths like `/home/user/linux`, not
  relative ones.
- **Set timeouts for long tasks.** Builds and VM tests can take minutes. Use
  `timeout: 300` or higher for them.
- **Clean up after VM tests.** Hung VMs waste resources. Call
  `kill_hanging_vms` if a test does not finish.
- **Keep the original tree untouched.** The `kerneldev-mcp/` source is a git
  clone. Update it with `git pull` — do not edit it directly.
