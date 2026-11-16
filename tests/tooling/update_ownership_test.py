"""Keep explicit Gradle update selectors and writable sources under ownership."""

import fnmatch
from pathlib import Path
import re
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
# Literal Groovy/Kotlin plugin versions need their own selectors when automatic
# dependency discovery is disabled; catalog-backed declarations have no literal.
PLUGIN_VERSION = re.compile(
    r"""^[ \t]*id(?:[ \t]+|\([ \t]*)['"](?P<id>[\w.-]+)['"][ \t]*\)?"""
    r"""[ \t]+version[ \t]+['"](?P<value>[^'"\r\n]+)['"]""",
    re.MULTILINE,
)


class UpdateOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.updates = tomllib.loads(
            (ROOT / "chainman/updates.toml").read_text()
        )["updates"]
        self.gradle = {
            name: spec for name, spec in self.updates["adapters"].items()
            if spec["adapter"] == "gradle"
        }

    def test_gradle_pin_files_are_inputs_and_authorized_outputs(self):
        for name, spec in self.gradle.items():
            for pin in spec.get("pins", []):
                with self.subTest(adapter=name, package=pin["name"]):
                    self.assertIn(pin["file"], spec["manifests"])
                    self.assertTrue(
                        any(fnmatch.fnmatchcase(pin["file"], pattern)
                            for pattern in self.updates["outputs"]),
                        f"{pin['file']} needs an authorized update output",
                    )

    def test_explicit_gradle_plugin_versions_have_unique_matching_pins(self):
        for name, spec in self.gradle.items():
            if not spec.get("explicit_only"):
                continue
            for path in spec["manifests"]:
                if not path.endswith((".gradle", ".gradle.kts")):
                    continue
                body = (ROOT / path).read_text()
                for declaration in PLUGIN_VERSION.finditer(body):
                    plugin = declaration["id"]
                    coordinate = f"{plugin}:{plugin}.gradle.plugin"
                    with self.subTest(adapter=name, file=path, plugin=plugin):
                        selectors = [
                            pin for pin in spec.get("pins", [])
                            if pin["file"] == path and pin["name"] == coordinate
                            and pin.get("format") == "regex"
                        ]
                        self.assertEqual(
                            len(selectors), 1,
                            f"{coordinate} needs one explicit version selector",
                        )
                        matches = list(re.finditer(
                            selectors[0]["pattern"], body, re.MULTILINE
                        ))
                        self.assertEqual(len(matches), 1)
                        self.assertEqual(
                            matches[0].span("value"), declaration.span("value"),
                            "Selector must own this plugin's version only",
                        )


if __name__ == "__main__":
    unittest.main()
