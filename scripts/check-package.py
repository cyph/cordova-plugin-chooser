"""Check source registration and package metadata without a native compiler."""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from privacy import BUNDLE, MANIFEST, check_plugin

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
package = json.loads((root / "package.json").read_text())
plugin = ET.parse(root / "plugin.xml").getroot()
ns = {"p": "http://www.phonegap.com/ns/plugins/1.0"}
assert plugin.attrib["id"] == package["name"] == package["cordova"]["id"]
assert plugin.attrib["version"] == package["version"]
assert package["main"] == "www/chooser.js"
assert package["types"] == "index.d.ts"
assert not package.get("dependencies"), "The plugin must not acquire runtime dependencies"
assert {p.attrib["name"] for p in plugin.findall("p:platform", ns)} == set(package["cordova"]["platforms"])
for platform, suffix in [("android", ".java"), ("ios", ".swift")]:
    registered = {p.attrib["src"] for p in plugin.findall(f"p:platform[@name='{platform}']/p:source-file", ns)}
    actual = {str(p.relative_to(root)) for p in (root / "src" / platform).glob(f"*{suffix}")}
    assert registered == actual, f"Incomplete {platform} source registration: {registered ^ actual}"
for source in plugin.findall(".//*[@src]"):
    path = root / source.attrib["src"]
    resource = source.tag == f"{{{ns['p']}}}resource-file"
    assert path.is_file() or (resource and path.is_dir()), f"Missing {source.attrib['src']}"
resources = plugin.findall("p:platform[@name='ios']/p:resource-file", ns)
assert [{"src": f"src/ios/{BUNDLE}", "target": BUNDLE}] == [p.attrib for p in resources], \
    "Register exactly one standalone plugin privacy bundle"
check_plugin(root / "src" / "ios" / BUNDLE / MANIFEST)
assert not plugin.findall(".//p:dependency", ns)
assert "uses-permission" not in (root / "plugin.xml").read_text()
assert "largeHeap" not in (root / "plugin.xml").read_text()
print("Package metadata and native/browser source registration agree.")
