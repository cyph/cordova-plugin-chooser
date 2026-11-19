import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeCapacitorFixture(
	webDir,
	packed,
	capacitorCore,
	page = "capacitor",
) {
	const paths = {
		"@capacitor/core": join(capacitorCore, "dist/index.cjs.js"),
		"../www/chooser-core": join(packed, "www/chooser-core.js"),
		"../src/browser/chooser-web": join(packed, "src/browser/chooser-web.js"),
		"./adapter": join(packed, "capacitor/adapter.js"),
		"cordova-plugin-chooser/capacitor": join(packed, "capacitor/index.js"),
	};
	// Bundle the exact packed modules for a browser/WebView without a build
	// dependency in the published package or a fake Capacitor bridge.
	const modules = Object.entries(paths).map(
		([name, path]) =>
			`${JSON.stringify(name)}: function(module, exports, require) {\n${readFileSync(path, "utf8")}\n}`,
	);
	writeFileSync(
		join(webDir, `${page}-fixture.js`),
		`(function () {
		const factories = {${modules.join(",\n")}};
		const modules = new Map();
		function require(name) {
			if (!modules.has(name)) {
				const module = {exports: {}};
				modules.set(name, module);
				factories[name](module, module.exports, require);
			}
			return modules.get(name).exports;
		}
		const {Chooser} = require("cordova-plugin-chooser/capacitor");
		window.chooser = Chooser;
		window.fixtureReady = true;
		document.getElementById("pick").disabled = false;
	}());\n`,
	);
	writeFileSync(
		join(webDir, `${page}.html`),
		`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Capacitor Chooser integration</title></head>
<body><button id="pick" disabled>Choose</button><script src="${page}-fixture.js"></script></body>
</html>\n`,
	);
}
