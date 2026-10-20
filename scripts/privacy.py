"""Validate the plugin privacy declaration and its installed/archive boundaries."""
import argparse
import json
from pathlib import Path
import plistlib
import re
import xml.etree.ElementTree as ET

BUNDLE = "ChooserPrivacy.bundle"
INDEPENDENT_BUNDLE = "IndependentPrivacy.bundle"
MANIFEST = "PrivacyInfo.xcprivacy"
FIXTURES = Path(__file__).resolve().parents[1] / "tests/ios"
EXPECTED = {
    "NSPrivacyTracking": False,
    "NSPrivacyTrackingDomains": [],
    "NSPrivacyCollectedDataTypes": [],
    "NSPrivacyAccessedAPITypes": [{
        "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
        "NSPrivacyAccessedAPITypeReasons": ["C617.1"],
    }],
}


def read_manifest(path):
    with Path(path).open("rb") as source:
        return plistlib.load(source)


def check_plugin(path):
    actual = read_manifest(path)
    assert actual == EXPECTED and actual["NSPrivacyTracking"] is False, \
        f"Unexpected plugin privacy declaration: {path}"


def fixture_declarations():
    manifest = ET.parse(FIXTURES / "privacy-app.xml").find("privacy-manifest")
    assert manifest is not None, "Missing fixture application declaration"
    plist = ET.Element("plist", version="1.0")
    dictionary = ET.SubElement(plist, "dict")
    dictionary.extend(manifest)
    app = plistlib.loads(ET.tostring(plist))
    independent = read_manifest(FIXTURES / "privacy-plugin" / INDEPENDENT_BUNDLE / MANIFEST)
    declarations = {"app": app, "independent": independent}
    # Empty defaults or identical declarations cannot prove coexistence.
    for declaration in declarations.values():
        assert declaration["NSPrivacyAccessedAPITypes"], "Empty fixture declaration"
        assert declaration != EXPECTED, "Fixture duplicates chooser's declaration"
    assert app != independent, "Fixture declarations must be distinct"
    return declarations


def check_manifest(path, expected):
    assert plistlib.dumps(read_manifest(path)) == plistlib.dumps(expected), \
        f"Privacy declaration changed: {path}"


def check_bundle(directory, name, expected, installed=True):
    bundles = list(directory.rglob(name))
    paths = [directory / name] if installed else []
    assert bundles == paths, f"Unexpected privacy bundles for {name}: {bundles}"
    if installed:
        check_manifest(bundles[0] / MANIFEST, expected)


def check_registration(contents, name, installed=True):
    # Xcode records one build-file definition and one resources-phase entry.
    entries = re.findall(r"/\* " + re.escape(name) + r" in Resources \*/", contents)
    assert len(entries) == (2 if installed else 0), \
        f"Missing or duplicate privacy build resource: {name}"
    if not installed:
        assert name not in contents, f"Stale privacy bundle reference: {name}"


def check_project(project, snapshot, installed):
    declarations = json.loads(Path(snapshot).read_text())
    check_manifest(project / MANIFEST, declarations["app"])
    resources = project / "Resources"
    check_bundle(resources, BUNDLE, EXPECTED, installed)
    check_bundle(resources, INDEPENDENT_BUNDLE, declarations["independent"])
    pbx = project.with_suffix(".xcodeproj") / "project.pbxproj"
    contents = pbx.read_text()
    check_registration(contents, BUNDLE, installed)
    check_registration(contents, INDEPENDENT_BUNDLE)


def snapshot_project(project, snapshot):
    declarations = fixture_declarations()
    # Validate the real prepared resources against the checked-in fixtures before
    # accepting a baseline; a default manifest must never become the expectation.
    check_manifest(project / MANIFEST, declarations["app"])
    check_bundle(project / "Resources", INDEPENDENT_BUNDLE, declarations["independent"])
    Path(snapshot).write_text(json.dumps(declarations))
    check_project(project, snapshot, False)


def check_archive(platform, snapshot):
    declarations = json.loads(Path(snapshot).read_text())
    apps = list(platform.glob("*.xcarchive/Products/Applications/*.app"))
    assert len(apps) == 1, f"Expected one archived application: {apps}"
    check_bundle(apps[0], BUNDLE, EXPECTED)
    check_bundle(apps[0], INDEPENDENT_BUNDLE, declarations["independent"])
    check_manifest(apps[0] / MANIFEST, declarations["app"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["snapshot", "installed", "removed", "archive"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    if args.operation == "snapshot":
        snapshot_project(args.directory, args.snapshot)
    elif args.operation == "archive":
        check_archive(args.directory, args.snapshot)
    else:
        check_project(args.directory, args.snapshot, args.operation == "installed")
    print(f"iOS privacy {args.operation}: app, chooser and independent plugin coexistence OK")


if __name__ == "__main__":
    main()
