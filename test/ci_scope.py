#!/usr/bin/env python3
"""Classify changed files so CI can skip unrelated heavyweight checks."""

import argparse
import subprocess


FRONTEND_ROOTS = {
    "sdk": "packages/sdk/",
    "dashboard": "apps/dashboard/",
    "website": "apps/website/",
    "toolchain": "packages/toolchain/",
}

RELEASE_TOOLING = {
    ".github/workflows/release.yml",
    ".github/workflows/release-recovery.yml",
    ".github/workflows/release-dry-run.yml",
    "scripts/assemble-release.ts",
    "test/release-tools.test.mjs",
}

# The digest baseline follows the owning change and must not widen its CI scope.
NEUTRAL_PATHS = {"test/conformance/baseline.json"}


def changed_files(base: str, head: str) -> list[str]:
    if not base or set(base) == {"0"}:
        base = subprocess.check_output(
            ["git", "rev-parse", "HEAD^"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    return subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=ACMRTUXB", base, head],
        text=True,
    ).splitlines()


def classify(paths: list[str]) -> tuple[str, str]:
    paths = [path for path in paths if path not in NEUTRAL_PATHS]
    if not paths:
        return "full", ""
    if all(
        path.startswith("docs/") or path in {"README.md", "README.zh.md"}
        for path in paths
    ):
        return "docs", ""

    if all(
        path in RELEASE_TOOLING
        or path.startswith("docs/")
        or path in {"README.md", "README.zh.md"}
        for path in paths
    ):
        return "release-tooling", ""

    components: set[str] = set()
    for path in paths:
        if path == "bun.lock" or path == "package.json":
            components.update(FRONTEND_ROOTS)
            continue
        match = next(
            (name for name, root in FRONTEND_ROOTS.items() if path.startswith(root)),
            None,
        )
        if match is None:
            return "full", ""
        components.add(match)
    return "frontend", ",".join(sorted(components))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args()
    paths = changed_files(args.base, args.head)
    scope, components = classify(paths)
    print(f"scope={scope}")
    print(f"components={components}")
    print(f"changed_files={len(paths)}")


if __name__ == "__main__":
    main()
