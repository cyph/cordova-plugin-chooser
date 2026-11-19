import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const flags = [
	"--noEmit",
	"--strict",
	"--exactOptionalPropertyTypes",
	"--noUncheckedIndexedAccess",
	"--lib",
	"ES2020,DOM",
];

function check(compiler, args, cwd = process.cwd()) {
	const result = spawnSync(process.execPath, [compiler, ...flags, ...args], {
		stdio: "inherit",
		cwd,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, "TypeScript contract compilation failed");
}

function examples(packed, run) {
	const consumer = mkdtempSync(join(tmpdir(), "chooser-ts-consumer-"));
	try {
		const modules = join(consumer, "node_modules");
		mkdirSync(join(modules, "@capacitor"), { recursive: true });
		symlinkSync(
			resolve(packed),
			join(modules, "cordova-plugin-chooser"),
			"junction",
		);
		for (const dependency of ["core", "app"]) {
			const path = dirname(
				require.resolve(`@capacitor/${dependency}/package.json`),
			);
			symlinkSync(path, join(modules, "@capacitor", dependency), "junction");
		}
		writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n');
		const examples = [
			["README.md", /### Pick a text file\n/, "capacitor"],
			["README.md", /### Pick a text file in Cordova\n/, "cordova"],
			["docs/FILE-HANDLING.md", /## Read a small file\n/, "file-handling"],
			[
				"docs/PLATFORMS.md",
				/### Restored Android results\n/,
				"restored-result",
			],
		].map(([file, section, name]) => {
			const document = readFileSync(join(packed, file), "utf8");
			const content = document
				.split(section)[1]
				?.match(/^\x60{3}ts\n([\s\S]*?)^\x60{3}$/m)?.[1];
			assert(content, `Missing documented TypeScript example in ${file}`);
			writeFileSync(join(consumer, `${name}.ts`), content);
			return `${name}.ts`;
		});
		for (const [module, moduleResolution] of [
			["NodeNext", "NodeNext"],
			["ESNext", "Bundler"],
		]) {
			run(
				[
					"--module",
					module,
					"--moduleResolution",
					moduleResolution,
					...examples,
				],
				consumer,
			);
		}
	} finally {
		rmSync(consumer, { recursive: true, force: true });
	}
}

for (const compiler of ["typescript-minimum", "typescript"]) {
	const packagePath = require.resolve(`${compiler}/package.json`);
	const { version, bin } = require(packagePath);
	console.log(`Checking public contracts with TypeScript ${version}`);
	const program = resolve(dirname(packagePath), bin.tsc);
	const packed = process.argv[2];
	if (packed) examples(packed, (args, cwd) => check(program, args, cwd));
	else
		check(program, [
			"--module",
			"node16",
			"--moduleResolution",
			"node16",
			"tests/types/contracts.ts",
		]);
}
