import unittest

from ci_scope import classify


class CiScopeTests(unittest.TestCase):
    def test_docs_only(self):
        self.assertEqual(classify(["docs/references/testing.md", "README.md"]), ("docs", ""))
        self.assertEqual(
            classify(["docs/references/testing.md", "test/conformance/baseline.json"]),
            ("docs", ""),
        )

    def test_release_tooling(self):
        self.assertEqual(
            classify(
                [
                    ".github/workflows/release.yml",
                    "scripts/assemble-release.ts",
                    "test/release-tools.test.mjs",
                    "docs/references/releasing.md",
                    "test/conformance/baseline.json",
                ]
            ),
            ("release-tooling", ""),
        )

    def test_frontend_components(self):
        self.assertEqual(
            classify(["packages/sdk/src/index.ts", "apps/dashboard/src/app.tsx"]),
            ("frontend", "dashboard,sdk"),
        )

    def test_runtime_and_workflow_changes_are_full(self):
        self.assertEqual(classify(["packages/runtime/src/loader.ts"]), ("full", ""))
        self.assertEqual(classify([".github/workflows/ci.yml"]), ("full", ""))
        self.assertEqual(
            classify([".github/workflows/release.yml", "Cargo.toml"]), ("full", "")
        )
        self.assertEqual(
            classify([".github/actions/setup-open-compute/action.yml"]), ("full", "")
        )


if __name__ == "__main__":
    unittest.main()
