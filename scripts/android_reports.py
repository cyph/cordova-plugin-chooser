"""Require executed Android tests, clean lint reports and packaged registration."""
import argparse
from pathlib import Path
import re
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


def check_instrumentation(directory):
    reports = list(directory.rglob("TEST-*.xml"))
    assert reports, "Missing instrumentation JUnit reports"
    suites = [ET.parse(path).getroot() for path in reports]
    assert all(int(suite.get(key, 0)) == 0 for suite in suites for key in ["failures", "errors", "skipped"]), "Failed or skipped instrumentation"
    executed = {case.get("name") for suite in suites for case in suite.iter("testcase") if "ChooserBridgeTest" in case.get("classname", "") and case.find("skipped") is None}
    required = {"realBridgeCopiesLargeFilesAndEnforcesLimits", "cancellationSettlesOnceAndCanImmediatelyReopen", "unknownLengthPdfPipesPreserveBytes"}
    assert required <= executed, f"Missing bridge cases: {required - executed}"


def config_paths(resources):
    """Follow xml/config's resource table entries, including optimized ZIP paths."""
    selected = False
    paths = set()
    for line in resources.splitlines():
        resource = re.match(r"\s*resource \S+ (\S+)", line)
        if resource:
            selected = resource.group(1).split(":")[-1] == "xml/config"
        elif selected:
            value = re.search(r"\(file\) (\S+) type=XML\b", line)
            if value:
                paths.add(value.group(1))
    assert paths, "Missing xml/config resource mapping"
    return paths


def check_apk(directory, resources):
    apks = list(directory.glob("*.apk"))
    assert len(apks) == 1, f"Expected one release APK: {apks}"
    with zipfile.ZipFile(apks[0]) as archive:
        for path in config_paths(resources):
            assert path in archive.namelist(), f"Missing packaged config: {path}"
            config = archive.read(path)
            # APK XML is binary and may encode strings as UTF-8 or UTF-16.
            assert any("com.cyph.cordova.Chooser".encode(encoding) in config for encoding in ["utf-8", "utf-16le"]), "Missing Chooser registration"
        dex = [archive.read(name) for name in archive.namelist() if name.startswith("classes") and name.endswith(".dex")]
        assert any(b"Lcom/cyph/cordova/Chooser;" in data for data in dex), "Chooser entrypoint missing from release DEX"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["tests", "lint", "apk", "instrumentation"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--resources", type=Path, help="AAPT2 dump resources output for the release APK")
    args = parser.parse_args()
    if args.operation == "apk":
        if not args.resources:
            parser.error("apk requires --resources")
        check_apk(args.directory, args.resources.read_text())
    else:
        {"tests": check_tests, "lint": check_lint, "instrumentation": check_instrumentation}[args.operation](args.directory)
    print(f"Android {args.operation}: OK")
