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

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from privacy import BUNDLE, EXPECTED, MANIFEST, check_archive, check_project


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
        self.bundle.mkdir(parents=True)
        (self.bundle / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        # An independent app declaration must survive plugin lifecycle operations.
        self.app_manifest = dict(EXPECTED, NSPrivacyAccessedAPITypes=[{
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
            "NSPrivacyAccessedAPITypeReasons": ["CA92.1"],
        }])
        (self.project / MANIFEST).write_bytes(plistlib.dumps(self.app_manifest))
        self.snapshot = self.platform / "privacy-snapshot.json"
        self.snapshot.write_text(json.dumps(self.app_manifest))
        self.pbx = self.platform / "App.xcodeproj/project.pbxproj"
        self.pbx.parent.mkdir()
        self.pbx.write_text("/* ChooserPrivacy.bundle in Resources */\n" * 2)

    def test_install_remove_and_reinstall(self):
        check_project(self.project, self.snapshot, True)
        shutil.rmtree(self.bundle)
        self.pbx.write_text("")
        check_project(self.project, self.snapshot, False)
        self.bundle.mkdir()
        (self.bundle / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        self.pbx.write_text("/* ChooserPrivacy.bundle in Resources */\n" * 2)
        check_project(self.project, self.snapshot, True)

    def test_duplicate_and_missing_build_resources(self):
        for count in [0, 1, 3, 4]:
            self.pbx.write_text("/* ChooserPrivacy.bundle in Resources */\n" * count)
            with self.assertRaises(AssertionError):
                check_project(self.project, self.snapshot, True)

    def test_app_manifest_overwrite(self):
        (self.project / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        with self.assertRaises(AssertionError):
            check_project(self.project, self.snapshot, True)

    def test_archive_requires_plugin_and_app_manifests(self):
        app = self.platform / "App.xcarchive/Products/Applications/Fixture.app"
        bundle = app / BUNDLE
        bundle.mkdir(parents=True)
        (bundle / MANIFEST).write_bytes(plistlib.dumps(EXPECTED, fmt=plistlib.FMT_BINARY))
        (app / MANIFEST).write_bytes(plistlib.dumps(self.app_manifest, fmt=plistlib.FMT_BINARY))
        check_archive(self.platform, self.snapshot)
        (bundle / MANIFEST).unlink()
        with self.assertRaises(FileNotFoundError):
            check_archive(self.platform, self.snapshot)
        (bundle / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        (app / MANIFEST).write_bytes(plistlib.dumps(EXPECTED))
        with self.assertRaises(AssertionError):
            check_archive(self.platform, self.snapshot)


if __name__ == "__main__":
    unittest.main()
