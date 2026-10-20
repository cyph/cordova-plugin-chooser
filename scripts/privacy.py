"""Validate the plugin privacy declaration and its installed/archive boundaries."""
import argparse
import json
from pathlib import Path
import plistlib
import re

BUNDLE = "ChooserPrivacy.bundle"
MANIFEST = "PrivacyInfo.xcprivacy"
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


def check_app(path, snapshot):
    assert read_manifest(path) == json.loads(Path(snapshot).read_text()), \
        f"Application privacy declaration changed: {path}"


def check_project(project, snapshot, installed):
    check_app(project / MANIFEST, snapshot)
    bundles = list((project / "Resources").rglob(BUNDLE))
    expected = [project / "Resources" / BUNDLE] if installed else []
    assert bundles == expected, f"Unexpected installed privacy bundles: {bundles}"
    if installed:
        check_plugin(bundles[0] / MANIFEST)
    pbx = project.with_suffix(".xcodeproj") / "project.pbxproj"
    contents = pbx.read_text()
    # Xcode records one build-file definition and one resources-phase entry.
    entries = re.findall(r"/\* ChooserPrivacy\.bundle in Resources \*/", contents)
    assert len(entries) == (2 if installed else 0), \
        f"Missing or duplicate privacy build resources: {pbx}"
    if not installed:
        assert BUNDLE not in contents, f"Stale privacy bundle reference: {pbx}"


def check_archive(platform, snapshot):
    apps = list(platform.glob("*.xcarchive/Products/Applications/*.app"))
    assert len(apps) == 1, f"Expected one archived application: {apps}"
    bundles = list(apps[0].rglob(BUNDLE))
    assert bundles == [apps[0] / BUNDLE], f"Unexpected archived privacy bundles: {bundles}"
    check_plugin(bundles[0] / MANIFEST)
    check_app(apps[0] / MANIFEST, snapshot)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["snapshot", "installed", "removed", "archive"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    if args.operation == "snapshot":
        args.snapshot.write_text(json.dumps(read_manifest(args.directory / MANIFEST)))
    elif args.operation == "archive":
        check_archive(args.directory, args.snapshot)
    else:
        check_project(args.directory, args.snapshot, args.operation == "installed")
    print(f"iOS privacy {args.operation}: OK")


if __name__ == "__main__":
    main()
