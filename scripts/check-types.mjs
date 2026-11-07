import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
for (const compiler of ["typescript-minimum", "typescript"]) {
	const packagePath = require.resolve(`${compiler}/package.json`);
	const { version, bin } = require(packagePath);
	console.log(`Checking public contracts with TypeScript ${version}`);
	const result = spawnSync(
		process.execPath,
		[
			resolve(dirname(packagePath), bin.tsc),
			"--noEmit",
			"--strict",
			"--exactOptionalPropertyTypes",
			"--noUncheckedIndexedAccess",
			"--module",
			"node16",
			"--moduleResolution",
			"node16",
			"--lib",
			"ES2020,DOM",
			"tests/types/contracts.ts",
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}
