import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolve only when packing. Doctor and fixture imports work without dependencies.
export function pinnedNpm(root) {
	const pin = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
		.devDependencies?.npm;
	assert.match(pin ?? "", /^\d+\.\d+\.\d+$/, "npm must have an exact pin");
	const require = createRequire(join(root, "package.json"));
	const manifest = require.resolve("npm/package.json");
	assert.equal(
		JSON.parse(readFileSync(manifest, "utf8")).version,
		pin,
		"Installed npm differs from the package pin; run just setup",
	);
	return {
		command: process.execPath,
		args: [join(dirname(manifest), "bin/npm-cli.js")],
	};
}
