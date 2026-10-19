import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Expose verified packages to Cordova's existing-package resolution shortcut.
export function stageFrozenPackage(application, source) {
	const metadata = JSON.parse(
		readFileSync(join(source, "package.json"), "utf8"),
	);
	function link(name, directory) {
		const destination = join(application, "node_modules", name);
		mkdirSync(dirname(destination), { recursive: true });
		if (existsSync(destination)) {
			assert.equal(
				realpathSync(destination),
				realpathSync(directory),
				`Unexpected fixture package ${name}`,
			);
		} else {
			symlinkSync(directory, destination, "dir");
		}
	}
	link(metadata.name, source);
	const require = createRequire(join(source, "package.json"));
	for (const name of Object.keys(metadata.dependencies || {})) {
		let directory = dirname(realpathSync(require.resolve(name)));
		while (true) {
			const manifest = join(directory, "package.json");
			if (
				existsSync(manifest) &&
				JSON.parse(readFileSync(manifest, "utf8")).name === name
			)
				break;
			const parent = dirname(directory);
			assert.notEqual(
				parent,
				directory,
				`Cannot locate frozen package ${name}`,
			);
			directory = parent;
		}
		link(name, directory);
	}
	return { name: metadata.name, version: metadata.version };
}
