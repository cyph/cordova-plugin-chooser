"""Require executed Android tests, clean lint reports and packaged registration."""
import argparse
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


def check_tests(directory):
    reports = list(directory.glob("TEST-*.xml"))
    assert reports, f"Missing JUnit reports: {directory}"
    suites = [ET.parse(path).getroot() for path in reports]
    assert any("ChooserTest" in suite.get("name", "") for suite in suites), "Provider suite did not execute"
    assert sum(int(suite.get("tests", 0)) for suite in suites) > 0, "Empty test execution"
    assert all(int(suite.get(key, 0)) == 0 for suite in suites for key in ["failures", "errors", "skipped"]), "Failed or skipped Android tests"


def check_lint(directory):
    for variant in ["debug", "release"]:
        path = directory / f"lint-results-{variant}.xml"
        issues = ET.parse(path).getroot().findall("issue")
        assert not issues, f"Untriaged Android lint findings: {path}"


def check_apk(directory):
    apks = list(directory.glob("*.apk"))
    assert len(apks) == 1, f"Expected one release APK: {apks}"
    with zipfile.ZipFile(apks[0]) as archive:
        config = archive.read("res/xml/config.xml")
        # APK XML is binary and may encode strings as UTF-8 or UTF-16.
        assert any("com.cyph.cordova.Chooser".encode(encoding) in config for encoding in ["utf-8", "utf-16le"]), "Missing Chooser registration"
        dex = [archive.read(name) for name in archive.namelist() if name.startswith("classes") and name.endswith(".dex")]
        assert any(b"Lcom/cyph/cordova/Chooser;" in data for data in dex), "Chooser entrypoint missing from release DEX"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["tests", "lint", "apk"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    {"tests": check_tests, "lint": check_lint, "apk": check_apk}[args.operation](args.directory)
    print(f"Android {args.operation}: OK")
