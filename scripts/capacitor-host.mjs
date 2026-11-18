import { mkdirSync, writeFileSync } from "node:fs";
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
	const dependencies = Object.fromEntries(
		(platform === "web" ? ["core"] : ["core", "cli", platform]).map((name) => [
			`@capacitor/${name}`,
			version,
		]),
	);
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ private: true, dependencies }),
	);
	const npm = pinnedNpm(root);
	run(
		npm.command,
		[
			...npm.args,
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--package-lock=false",
		],
		directory,
		false,
		env,
	);
	return join(directory, "node_modules");
}
