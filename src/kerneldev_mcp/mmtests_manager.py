"""
MM selftests management - category validation, TAP output parsing, and result formatting.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

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
