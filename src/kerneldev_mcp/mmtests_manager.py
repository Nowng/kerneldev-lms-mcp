"""
MM selftests management - category validation, TAP output parsing, and result formatting.

Covers both VM-based selftests (tools/testing/selftests/mm) and host-side
userspace tests (tools/testing/{radix-tree,vma,memblock}).
"""

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# All categories from tools/testing/selftests/mm/run_vmtests.sh
MM_TEST_CATEGORIES = {
    "mmap": "tests for mmap(2)",
    "gup_test": "tests for get_user_pages",
    "userfaultfd": "tests for userfaultfd(2)",
    "compaction": "test compaction of unevictable pages",
    "mlock": "tests for mlock(2)",
    "mremap": "tests for mremap(2)",
    "hugevm": "tests for very large virtual address space",
    "vmalloc": "vmalloc smoke tests",
    "hmm": "hmm smoke tests",
    "madv_guard": "test madvise MADV_GUARD_INSTALL/REMOVE",
    "madv_populate": "test madvise MADV_POPULATE_READ/WRITE",
    "memfd_secret": "test memfd_secret(2)",
    "process_mrelease": "test process_mrelease(2)",
    "ksm": "KSM tests (single NUMA node)",
    "ksm_numa": "KSM tests requiring >=2 NUMA nodes",
    "pkey": "memory protection key tests",
    "soft_dirty": "test soft dirty page bit semantics",
    "pagemap": "test pagemap_scan IOCTL",
    "pfnmap": "tests for VM_PFNMAP handling",
    "process_madv": "test process_madvise",
    "cow": "test copy-on-write semantics",
    "thp": "test transparent huge pages",
    "hugetlb": "test hugetlbfs huge pages",
    "migration": "test move_pages(2) migration entry code paths",
    "mkdirty": "test PTE/PMD dirty handling in read-only VMAs",
    "mdwe": "test prctl(PR_SET_MDWE, ...)",
    "page_frag": "test page fragment allocation and freeing",
    "vma_merge": "test VMA merge cases",
    "rmap": "test rmap behavior",
}


@dataclass
class MmTestResult:
    """Result of a single mm selftest."""

    test_name: str
    test_number: int
    status: str  # "passed", "failed", "skipped"
    exit_code: Optional[int] = None
    output_lines: List[str] = field(default_factory=list)


@dataclass
class MmtestsRunResult:
    """Result of an mm selftests run."""

    success: bool
    total: int
    passed: int
    failed: int
    skipped: int
    test_results: List[MmTestResult] = field(default_factory=list)
    duration: float = 0.0
    build_success: bool = True
    log_file: Optional[str] = None

    def summary(self) -> str:
        if self.total == 0:
            return "No tests run"
        status_icon = "✓" if self.failed == 0 else "✗"
        parts = [f"{status_icon} {self.passed}/{self.total} passed"]
        if self.failed > 0:
            parts.append(f"{self.failed} failed")
        if self.skipped > 0:
            parts.append(f"{self.skipped} skipped")
        parts.append(f"{self.duration:.1f}s")
        return ", ".join(parts)


def validate_categories(categories: List[str]) -> Tuple[bool, Optional[str]]:
    """Validate mm selftest categories against the known list.

    Args:
        categories: List of category names to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not categories:
        return True, None

    unknown = [c for c in categories if c not in MM_TEST_CATEGORIES]
    if unknown:
        valid_list = ", ".join(sorted(MM_TEST_CATEGORIES.keys()))
        return False, (
            f"Unknown categories: {', '.join(unknown)}. "
            f"Valid categories: {valid_list}"
        )
    return True, None


def parse_tap_output(output: str) -> MmtestsRunResult:
    """Parse TAP output from run_vmtests.sh.

    Handles TAP lines like:
        ok 1 hugepage-mmap
        ok 2 some_test # SKIP
        not ok 3 failing_test # exit=1
        SUMMARY: PASS=10 SKIP=2 FAIL=1
        1..13

    Also strips kernel dmesg timestamps that may be interleaved.

    Args:
        output: Full VM output including TAP lines

    Returns:
        MmtestsRunResult with parsed test results
    """
    test_results: List[MmTestResult] = []
    summary_pass = None
    summary_fail = None
    summary_skip = None
    tap_plan_total = None

    # Accumulate output lines per test for context
    current_output_lines: List[str] = []

    for raw_line in output.splitlines():
        # Strip kernel dmesg timestamps: [    1.234567]
        line = re.sub(r"^\[\s*\d+\.\d+\]\s*", "", raw_line).strip()

        # TAP ok line: "ok N test_name" or "ok N test_name # SKIP"
        m = re.match(r"^ok\s+(\d+)\s+(.+?)(?:\s+#\s+SKIP.*)?$", line)
        if m:
            num = int(m.group(1))
            name = m.group(2).strip()
            if "# SKIP" in line:
                status = "skipped"
            else:
                status = "passed"
            test_results.append(MmTestResult(
                test_name=name,
                test_number=num,
                status=status,
                output_lines=current_output_lines,
            ))
            current_output_lines = []
            continue

        # TAP not ok line: "not ok N test_name # exit=RET"
        m = re.match(r"^not ok\s+(\d+)\s+(.+?)(?:\s+#\s+exit=(\d+))?$", line)
        if m:
            num = int(m.group(1))
            name = m.group(2).strip()
            exit_code = int(m.group(3)) if m.group(3) else None
            test_results.append(MmTestResult(
                test_name=name,
                test_number=num,
                status="failed",
                exit_code=exit_code,
                output_lines=current_output_lines,
            ))
            current_output_lines = []
            continue

        # SUMMARY line: "SUMMARY: PASS=N SKIP=N FAIL=N"
        m = re.match(r"^#?\s*SUMMARY:\s+PASS=(\d+)\s+SKIP=(\d+)\s+FAIL=(\d+)", line)
        if m:
            summary_pass = int(m.group(1))
            summary_skip = int(m.group(2))
            summary_fail = int(m.group(3))
            continue

        # TAP plan line: "1..N"
        m = re.match(r"^1\.\.(\d+)$", line)
        if m:
            tap_plan_total = int(m.group(1))
            continue

        # Collect non-TAP output as context for the next test
        if line and not line.startswith("TAP version"):
            current_output_lines.append(line)

    passed = sum(1 for t in test_results if t.status == "passed")
    failed = sum(1 for t in test_results if t.status == "failed")
    skipped = sum(1 for t in test_results if t.status == "skipped")
    total = len(test_results)

    # Cross-check with SUMMARY line if available
    if summary_pass is not None:
        if summary_pass != passed or summary_fail != failed or summary_skip != skipped:
            logger.warning(
                f"TAP parse mismatch vs SUMMARY: parsed {passed}/{failed}/{skipped} "
                f"vs SUMMARY {summary_pass}/{summary_fail}/{summary_skip}"
            )
            # Trust parsed results when there's a mismatch due to possible
            # interleaved dmesg corrupting some TAP lines, but if we found
            # fewer tests than SUMMARY claims, the SUMMARY is likely correct
            if total < (summary_pass + summary_fail + summary_skip):
                total = summary_pass + summary_fail + summary_skip
                passed = summary_pass
                failed = summary_fail
                skipped = summary_skip

    # If we got nothing from TAP lines, try SUMMARY as fallback
    if total == 0 and summary_pass is not None:
        total = summary_pass + summary_fail + summary_skip
        passed = summary_pass
        failed = summary_fail
        skipped = summary_skip

    # Check for build failure
    build_success = True
    if re.search(r"make.*Error\s+\d+|make\[.*\]\s+\*\*\*.*Error", output):
        build_success = False

    return MmtestsRunResult(
        success=(failed == 0 and build_success),
        total=total,
        passed=passed,
        failed=failed,
        skipped=skipped,
        test_results=test_results,
        build_success=build_success,
    )


def format_mmtests_result(result: MmtestsRunResult, max_failures: int = 20) -> str:
    """Format mm selftests result for display.

    Args:
        result: MmtestsRunResult to format
        max_failures: Maximum number of failures to show details for

    Returns:
        Formatted string
    """
    lines = [result.summary(), ""]

    if not result.build_success:
        lines.append("BUILD FAILED - selftests did not compile successfully")
        lines.append("")

    # Show failed tests
    failed_tests = [t for t in result.test_results if t.status == "failed"]
    if failed_tests:
        lines.append(f"Failed Tests ({len(failed_tests)}):")
        for i, test in enumerate(failed_tests[:max_failures], 1):
            exit_info = f" (exit={test.exit_code})" if test.exit_code is not None else ""
            lines.append(f"  {i}. {test.test_name}{exit_info}")
        if len(failed_tests) > max_failures:
            lines.append(f"  ... and {len(failed_tests) - max_failures} more failures")
        lines.append("")

    # Show skipped tests (first few)
    skipped_tests = [t for t in result.test_results if t.status == "skipped"]
    if skipped_tests:
        lines.append(f"Skipped ({len(skipped_tests)}):")
        for i, test in enumerate(skipped_tests[:10], 1):
            lines.append(f"  {i}. {test.test_name}")
        if len(skipped_tests) > 10:
            lines.append(f"  ... and {len(skipped_tests) - 10} more")
        lines.append("")

    if result.log_file:
        lines.append(f"Full log: {result.log_file}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Host-side userspace mm tests (no VM required)
# ---------------------------------------------------------------------------

# Each suite: relative path from kernel root, make targets, test binaries
HOST_TEST_SUITES: Dict[str, Dict] = {
    "radix-tree": {
        "path": "tools/testing/radix-tree",
        "description": "radix-tree, xarray, maple tree, and IDR tests",
        "make_target": "targets",
        "binaries": ["main", "idr-test", "xarray", "maple"],
    },
    "vma": {
        "path": "tools/testing/vma",
        "description": "VMA merge, modify, expand, and shrink tests",
        "make_target": "default",
        "binaries": ["vma"],
    },
    "memblock": {
        "path": "tools/testing/memblock",
        "description": "memblock allocator tests",
        "make_target": "main",
        "binaries": ["main"],
    },
}


def validate_host_suites(suites: List[str]) -> Tuple[bool, Optional[str]]:
    """Validate host test suite names.

    Args:
        suites: List of suite names to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not suites:
        return True, None

    unknown = [s for s in suites if s not in HOST_TEST_SUITES]
    if unknown:
        valid = ", ".join(sorted(HOST_TEST_SUITES.keys()))
        return False, (
            f"Unknown suites: {', '.join(unknown)}. "
            f"Valid suites: {valid}"
        )
    return True, None


@dataclass
class HostTestSuiteResult:
    """Result of running a single host test suite."""

    suite_name: str
    success: bool
    build_success: bool
    build_output: str = ""
    total: int = 0
    passed: int = 0
    failed: int = 0
    run_output: str = ""
    duration: float = 0.0
    binary_results: Dict[str, bool] = field(default_factory=dict)


@dataclass
class HostMmtestsRunResult:
    """Aggregate result of all host mm test suites."""

    success: bool
    suite_results: List[HostTestSuiteResult] = field(default_factory=list)
    duration: float = 0.0

    def summary(self) -> str:
        total_suites = len(self.suite_results)
        passed_suites = sum(1 for s in self.suite_results if s.success)
        failed_suites = total_suites - passed_suites
        icon = "✓" if self.success else "✗"
        return f"{icon} {passed_suites}/{total_suites} suites passed, {self.duration:.1f}s"


def _parse_vma_output(output: str) -> Tuple[int, int, int]:
    """Parse vma test output: 'N tests run, M passed, K failed.'"""
    m = re.search(r"(\d+)\s+tests?\s+run,\s+(\d+)\s+passed,\s+(\d+)\s+failed", output)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3))
    return 0, 0, 0


def _check_assertion_output(output: str) -> bool:
    """Check for assertion failures or sanitizer errors in output."""
    fail_patterns = [
        r"Assert FAILED",
        r"Assertion .* failed",
        r"runtime error:",           # UBSAN
        r"ERROR: AddressSanitizer",   # ASAN
        r"SUMMARY: .*Sanitizer",
    ]
    for pat in fail_patterns:
        if re.search(pat, output):
            return True
    return False


async def run_host_mmtests(
    kernel_path: Path,
    suites: Optional[List[str]] = None,
    timeout: int = 300,
    jobs: Optional[int] = None,
) -> HostMmtestsRunResult:
    """Build and run host-side mm test suites.

    These tests compile against kernel headers and run directly on the host
    without a VM.  They require liburcu-dev and libasan.

    Args:
        kernel_path: Path to kernel source tree
        suites: List of suite names to run, or None for all
        timeout: Timeout per suite in seconds
        jobs: Parallel make jobs (default: CPU count)

    Returns:
        HostMmtestsRunResult with per-suite results
    """
    if suites is None:
        suites = list(HOST_TEST_SUITES.keys())

    if jobs is None:
        jobs = os.cpu_count() or 1

    start_time = time.time()
    suite_results: List[HostTestSuiteResult] = []
    all_success = True

    for suite_name in suites:
        info = HOST_TEST_SUITES[suite_name]
        suite_dir = kernel_path / info["path"]
        suite_start = time.time()

        logger.info(f"--- {suite_name}: building ---")

        if not suite_dir.exists():
            sr = HostTestSuiteResult(
                suite_name=suite_name,
                success=False,
                build_success=False,
                build_output=f"Directory not found: {suite_dir}",
            )
            suite_results.append(sr)
            all_success = False
            continue

        # Build
        build_cmd = f"make -C {suite_dir} {info['make_target']} -j{jobs}"
        try:
            proc = await asyncio.create_subprocess_shell(
                build_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(kernel_path),
            )
            build_out_bytes, _ = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
            build_output = build_out_bytes.decode(errors="replace")
            build_ok = proc.returncode == 0
        except asyncio.TimeoutError:
            build_output = f"Build timed out after {timeout}s"
            build_ok = False
        except Exception as e:
            build_output = str(e)
            build_ok = False

        if not build_ok:
            logger.error(f"--- {suite_name}: build FAILED ---")
            sr = HostTestSuiteResult(
                suite_name=suite_name,
                success=False,
                build_success=False,
                build_output=build_output,
                duration=time.time() - suite_start,
            )
            suite_results.append(sr)
            all_success = False
            continue

        logger.info(f"--- {suite_name}: running ---")

        # Run each binary
        binary_results: Dict[str, bool] = {}
        combined_output_parts: List[str] = []
        total = 0
        passed = 0
        failed = 0
        suite_ok = True

        for binary in info["binaries"]:
            binary_path = suite_dir / binary
            if not binary_path.exists():
                binary_results[binary] = False
                combined_output_parts.append(f"[{binary}] NOT FOUND")
                suite_ok = False
                continue

            # memblock supports -v for verbose kselftest output
            run_cmd = str(binary_path)
            if suite_name == "memblock":
                run_cmd += " -v"

            try:
                proc = await asyncio.create_subprocess_shell(
                    run_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=str(suite_dir),
                )
                out_bytes, _ = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )
                run_output = out_bytes.decode(errors="replace")
                exit_code = proc.returncode
            except asyncio.TimeoutError:
                run_output = f"Timed out after {timeout}s"
                exit_code = -1
            except Exception as e:
                run_output = str(e)
                exit_code = -1

            combined_output_parts.append(f"[{binary}] exit={exit_code}")
            if run_output.strip():
                combined_output_parts.append(run_output.rstrip())

            # Determine pass/fail
            has_assertion_fail = _check_assertion_output(run_output)

            if suite_name == "vma":
                t, p, f = _parse_vma_output(run_output)
                total += t
                passed += p
                failed += f
                bin_ok = (exit_code == 0 and f == 0)
            else:
                # radix-tree and memblock: exit 0 + no assertion/sanitizer errors = pass
                total += 1
                bin_ok = (exit_code == 0 and not has_assertion_fail)
                if bin_ok:
                    passed += 1
                else:
                    failed += 1

            binary_results[binary] = bin_ok
            if not bin_ok:
                suite_ok = False

        sr = HostTestSuiteResult(
            suite_name=suite_name,
            success=suite_ok,
            build_success=True,
            total=total,
            passed=passed,
            failed=failed,
            run_output="\n".join(combined_output_parts),
            duration=time.time() - suite_start,
            binary_results=binary_results,
        )
        suite_results.append(sr)
        if not suite_ok:
            all_success = False

        status = "✓" if suite_ok else "✗"
        logger.info(f"--- {suite_name}: {status} ({sr.duration:.1f}s) ---")

    return HostMmtestsRunResult(
        success=all_success,
        suite_results=suite_results,
        duration=time.time() - start_time,
    )


def format_host_mmtests_result(result: HostMmtestsRunResult) -> str:
    """Format host mm test results for display."""
    lines = [result.summary(), ""]

    for sr in result.suite_results:
        icon = "✓" if sr.success else "✗"

        if not sr.build_success:
            lines.append(f"  {icon} {sr.suite_name}: BUILD FAILED ({sr.duration:.1f}s)")
            # Show last few lines of build output
            build_lines = sr.build_output.strip().splitlines()
            for bl in build_lines[-5:]:
                lines.append(f"      {bl}")
        elif sr.suite_name == "vma":
            lines.append(
                f"  {icon} {sr.suite_name}: {sr.passed}/{sr.total} passed, "
                f"{sr.failed} failed ({sr.duration:.1f}s)"
            )
        else:
            # radix-tree / memblock: show per-binary status
            parts = []
            for binary, ok in sr.binary_results.items():
                parts.append(f"{binary}={'ok' if ok else 'FAIL'}")
            lines.append(
                f"  {icon} {sr.suite_name}: {', '.join(parts)} ({sr.duration:.1f}s)"
            )

        # On failure, show some output
        if not sr.success and sr.run_output:
            for ol in sr.run_output.strip().splitlines()[-8:]:
                lines.append(f"      {ol}")

        lines.append("")

    return "\n".join(lines)
