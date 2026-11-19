import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pinnedNpm } from "./npm.mjs";

export function installCapacitorHost(
	root,
	directory,
	platform,
	version,
	run,
	env = {},
) {
	mkdirSync(directory, { recursive: true });
	const frozen = join(root, "tests/capacitor-host", `${platform}-${version}`);
	for (const name of ["package.json", "package-lock.json"]) {
		copyFileSync(join(frozen, name), join(directory, name));
	}
	const npm = pinnedNpm(root);
	run(
		npm.command,
		[...npm.args, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
		directory,
		false,
		env,
	);
	return join(directory, "node_modules");
}
