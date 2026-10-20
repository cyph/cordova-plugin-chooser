"""Portable negative cases for packaged and installed privacy resources."""
import copy
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from privacy import (
    BUNDLE, EXPECTED, INDEPENDENT_BUNDLE, MANIFEST, check_archive,
    check_project, fixture_declarations, snapshot_project,
)


class FixturePrivacyTests(unittest.TestCase):
    def test_fixture_stays_local_and_dependency_free(self):
        fixture = ROOT / "tests/ios/privacy-plugin"
        package = json.loads((fixture / "package.json").read_text())
        self.assertIs(package["private"], True)
        for key in [
            "dependencies", "devDependencies", "optionalDependencies",
            "peerDependencies", "bundledDependencies", "bundleDependencies", "scripts",
        ]:
            self.assertFalse(package.get(key), f"Declare chainman ownership before adding {key}")
        plugin = ET.parse(fixture / "plugin.xml").getroot()
        self.assertEqual(plugin.attrib["id"], package["name"])
        self.assertEqual(plugin.attrib["version"], package["version"])
        self.assertFalse(plugin.findall(".//{*}dependency"))
        self.assertFalse(plugin.findall(".//{*}framework"))
        self.assertFalse(plugin.findall(".//{*}hook"))


class PackagePrivacyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="chooser-privacy-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ["src", "www"]:
            shutil.copytree(ROOT / name, self.root / name)
        for name in ["package.json", "plugin.xml"]:
            shutil.copyfile(ROOT / name, self.root / name)
        self.manifest = self.root / "src/ios" / BUNDLE / MANIFEST

    def check(self, success):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/check-package.py"), str(self.root)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)

    def test_valid_bundle(self):
        self.check(True)

    def test_missing_or_malformed_manifest(self):
        self.manifest.unlink()
        self.check(False)
        self.manifest.write_text("<plist><dict>")
        self.check(False)

    def test_incorrect_declarations(self):
        for key, value in [
            ("NSPrivacyTracking", True),
            ("NSPrivacyTracking", 0),
            ("NSPrivacyTrackingDomains", ["example.invalid"]),
            ("NSPrivacyCollectedDataTypes", [{"unexpected": True}]),
            ("NSPrivacyAccessedAPITypes", []),
            ("NSPrivacyAccessedAPITypes", [{
                "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
                "NSPrivacyAccessedAPITypeReasons": ["DDA9.1"],
            }]),
        ]:
            with self.subTest(key=key, value=value):
                contents = copy.deepcopy(EXPECTED)
                contents[key] = value
                self.manifest.write_bytes(plistlib.dumps(contents))
                self.check(False)

    def test_bundle_must_be_registered_once(self):
        plugin = self.root / "plugin.xml"
        original = plugin.read_text()
        registration = '<resource-file src="src/ios/ChooserPrivacy.bundle" target="ChooserPrivacy.bundle" />'
        for replacement in ["", registration + registration]:
            plugin.write_text(original.replace(registration, replacement))
            self.check(False)

    def test_source_file_cannot_be_a_directory(self):
        source = self.root / "src/ios/Chooser.swift"
        source.unlink()
        source.mkdir()
        self.check(False)


class InstalledPrivacyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="chooser-installed-privacy-")
        self.addCleanup(temporary.cleanup)
        self.platform = Path(temporary.name)
        self.project = self.platform / "App"
        self.bundle = self.project / "Resources" / BUNDLE
        self.independent = self.project / "Resources" / INDEPENDENT_BUNDLE
        declarations = fixture_declarations()
        self.app_manifest = declarations["app"]
        self.independent_manifest = declarations["independent"]
        self.independent.mkdir(parents=True)
        (self.independent / MANIFEST).write_bytes(plistlib.dumps(self.independent_manifest))
        (self.project / MANIFEST).write_bytes(plistlib.dumps(self.app_manifest))
        self.snapshot = self.platform / "privacy-snapshot.json"
        self.pbx = self.platform / "App.xcodeproj/project.pbxproj"
        self.pbx.parent.mkdir()
        self.registration(chooser=0)
        snapshot_project(self.project, self.snapshot)
        self.install()

    def registration(self, chooser=2, independent=2):
        self.pbx.write_text(
            f"/* {BUNDLE} in Resources */\n" * chooser
            + f"/* {INDEPENDENT_BUNDLE} in Resources */\n" * independent
        )

    def install(self):
        self.bundle.mkdir()
        (self.bundle / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        self.registration()

    def remove(self):
        shutil.rmtree(self.bundle)
        self.registration(chooser=0)

    def test_install_remove_and_reinstall(self):
        check_project(self.project, self.snapshot, True)
        self.remove()
        check_project(self.project, self.snapshot, False)
        self.install()
        check_project(self.project, self.snapshot, True)

    def test_duplicate_and_missing_build_resources(self):
        for resource in ["chooser", "independent"]:
            for count in [0, 1, 3, 4]:
                with self.subTest(resource=resource, count=count):
                    self.registration(**{resource: count})
                    with self.assertRaises(AssertionError):
                        check_project(self.project, self.snapshot, True)

    def test_snapshot_rejects_empty_or_overwritten_app(self):
        self.remove()
        for declaration in [dict(self.app_manifest, NSPrivacyAccessedAPITypes=[]), EXPECTED]:
            (self.project / MANIFEST).write_bytes(plistlib.dumps(declaration))
            with self.assertRaises(AssertionError):
                snapshot_project(self.project, self.snapshot)

    def test_snapshot_rejects_missing_or_overwritten_independent_plugin(self):
        self.remove()
        (self.independent / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        with self.assertRaises(AssertionError):
            snapshot_project(self.project, self.snapshot)
        shutil.rmtree(self.independent)
        with self.assertRaises(AssertionError):
            snapshot_project(self.project, self.snapshot)

    def test_app_manifest_overwrite(self):
        for declaration in [EXPECTED, dict(self.app_manifest, NSPrivacyAccessedAPITypes=[])]:
            (self.project / MANIFEST).write_bytes(plistlib.dumps(declaration))
            with self.assertRaises(AssertionError):
                check_project(self.project, self.snapshot, True)

    def test_independent_manifest_overwrite(self):
        (self.independent / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        with self.assertRaises(AssertionError):
            check_project(self.project, self.snapshot, True)

    def test_plugin_removal_must_preserve_independent_resources(self):
        self.remove()
        self.registration(chooser=0, independent=0)
        with self.assertRaises(AssertionError):
            check_project(self.project, self.snapshot, False)
        self.registration(chooser=0)
        shutil.rmtree(self.independent)
        with self.assertRaises(AssertionError):
            check_project(self.project, self.snapshot, False)

    def test_plugin_removal_must_remove_stale_registration(self):
        self.remove()
        self.pbx.write_text(self.pbx.read_text() + f"/* {BUNDLE} */")
        with self.assertRaises(AssertionError):
            check_project(self.project, self.snapshot, False)

    def test_tracking_must_remain_boolean(self):
        for path, declaration in [
            (self.project / MANIFEST, self.app_manifest),
            (self.bundle / MANIFEST, EXPECTED),
            (self.independent / MANIFEST, self.independent_manifest),
        ]:
            path.write_bytes(plistlib.dumps(dict(declaration, NSPrivacyTracking=0)))
            with self.assertRaises(AssertionError):
                check_project(self.project, self.snapshot, True)
            path.write_bytes(plistlib.dumps(declaration))

    def archive(self):
        app = self.platform / "App.xcarchive/Products/Applications/Fixture.app"
        for name, declaration in [(BUNDLE, EXPECTED), (INDEPENDENT_BUNDLE, self.independent_manifest)]:
            bundle = app / name
            bundle.mkdir(parents=True)
            (bundle / MANIFEST).write_bytes(plistlib.dumps(declaration, fmt=plistlib.FMT_BINARY))
        (app / MANIFEST).write_bytes(plistlib.dumps(self.app_manifest, fmt=plistlib.FMT_BINARY))
        return app

    def test_archive_requires_all_manifests_unchanged(self):
        app = self.archive()
        check_archive(self.platform, self.snapshot)
        for directory in [app, app / BUNDLE, app / INDEPENDENT_BUNDLE]:
            path = directory / MANIFEST
            original = path.read_bytes()
            with self.subTest(directory=directory):
                path.unlink()
                with self.assertRaises(FileNotFoundError):
                    check_archive(self.platform, self.snapshot)
                path.write_bytes(plistlib.dumps(dict(EXPECTED, NSPrivacyAccessedAPITypes=[])))
                with self.assertRaises(AssertionError):
                    check_archive(self.platform, self.snapshot)
                path.write_bytes(original)

    def test_archive_rejects_missing_or_nested_bundles(self):
        app = self.archive()
        for name in [BUNDLE, INDEPENDENT_BUNDLE]:
            with self.subTest(bundle=name):
                nested = app / "Nested"
                nested.mkdir(exist_ok=True)
                (app / name).rename(self.platform / name)
                with self.assertRaises(AssertionError):
                    check_archive(self.platform, self.snapshot)
                (self.platform / name).rename(nested / name)
                with self.assertRaises(AssertionError):
                    check_archive(self.platform, self.snapshot)
                (nested / name).rename(app / name)


if __name__ == "__main__":
    unittest.main()
