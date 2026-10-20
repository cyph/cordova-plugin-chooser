import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function checkPackedFiles(root, pkg, entries) {
	const files = new Set(entries);
	for (const name of [
		"package.json",
		"plugin.xml",
		pkg.main,
		pkg.types,
		"LICENSE",
		"NOTICE",
	])
		assert(files.has(name), `Missing packed ${name}`);
	function checkDirectory(directory) {
		for (const entry of readdirSync(join(root, directory), {
			withFileTypes: true,
		})) {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) checkDirectory(path);
			else {
				assert(entry.isFile(), `Unexpected source entry ${path}`);
				assert(files.has(path), `Missing packed ${path}`);
			}
		}
	}
	checkDirectory("src");
	for (const name of files)
		assert(
			!/^(tests|scripts|node_modules|\.verification|\.chainman|\.github)\//.test(
				name,
			),
			`Unexpected packed ${name}`,
		);
}
