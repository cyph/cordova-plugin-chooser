"""Negative cases for Android qualification evidence, independent of Gradle."""
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from android_reports import check_apk, check_lint, check_tests


class AndroidReportsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_tests_must_execute_provider_suite_without_skips(self):
        with self.assertRaises(AssertionError):
            check_tests(self.directory)
        report = self.directory / "TEST-fixture.xml"
        for attributes in ['tests="0"', 'tests="1" skipped="1"', 'tests="1" failures="1"']:
            report.write_text(f'<testsuite name="ChooserTest" {attributes}/>')
            with self.assertRaises(AssertionError):
                check_tests(self.directory)
        report.write_text('<testsuite name="ChooserTest" tests="1"/>')
        check_tests(self.directory)

    def test_both_lint_configurations_must_be_clean(self):
        for variant in ["debug", "release"]:
            (self.directory / f"lint-results-{variant}.xml").write_text('<issues/>')
        check_lint(self.directory)
        (self.directory / "lint-results-release.xml").write_text('<issues><issue severity="Warning"/></issues>')
        with self.assertRaises(AssertionError):
            check_lint(self.directory)

    def test_release_apk_requires_registration_and_entrypoint(self):
        def apk(config, dex):
            with zipfile.ZipFile(self.directory / "app-release.apk", "w") as archive:
                archive.writestr("res/xml/config.xml", config)
                archive.writestr("classes.dex", dex)
        for encoding in ["utf-8", "utf-16le"]:
            apk("com.cyph.cordova.Chooser".encode(encoding), b"Lcom/cyph/cordova/Chooser;")
            check_apk(self.directory)
        for config, dex in [(b"", b"Lcom/cyph/cordova/Chooser;"), (b"com.cyph.cordova.Chooser", b"")]:
            apk(config, dex)
            with self.assertRaises(AssertionError):
                check_apk(self.directory)
