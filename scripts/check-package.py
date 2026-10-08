"""Check source registration and package metadata without a native compiler."""
import json
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
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
    assert (root / source.attrib["src"]).is_file(), f"Missing {source.attrib['src']}"
assert not plugin.findall(".//p:dependency", ns)
assert "uses-permission" not in (root / "plugin.xml").read_text()
assert "largeHeap" not in (root / "plugin.xml").read_text()
print("Package metadata and native/browser source registration agree.")
