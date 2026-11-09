const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { cpSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");

const config = JSON.parse(
	readFileSync(process.env.CHOOSER_RELEASE_FIXTURE, "utf8"),
);

if (process.argv[2] === "publisher") {
	assert.deepEqual(process.argv.slice(3, 5), ["chainman", "npm-publish"]);
	assert.deepEqual(process.argv.slice(-2), ["--run", "123"]);
	assert(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
	process.stderr.write("terminal stderr connected\n");
	process.stdout.write("offline publication prompt: ");
	createInterface({ input: process.stdin }).once("line", (input) => {
		assert.equal(input, "offline-test-code");
		process.stdout.write("terminal input received\n");
		process.exit(config.exitCode);
	});
} else
	(async () => {
		const { publishRelease } = await import("../../../scripts/release.mjs");
		const run = (command, args, cwd) => {
			if (command === "git") {
				if (args[0] === "status") return "";
				if (args[0] === "rev-parse") return config.commit;
				assert.equal(args[0], "archive");
				return "";
			}
			if (command === "python3" && args[0] === "-m") {
				cpSync(config.source, args[4], { recursive: true });
				return "";
			}
			if (command === "fixture-npm") {
				cpSync(config.archive, join(args.at(-1), config.info.filename));
				return JSON.stringify({ [config.info.name]: config.info });
			}
			assert.equal(command, "python3");
			assert.equal(args[0], "-c");
			const result = spawnSync(command, args, { cwd, encoding: "utf8" });
			assert.equal(result.status, 0, result.stdout + result.stderr);
			return result.stdout.trim();
		};
		publishRelease({
			root: config.root,
			runId: "123",
			run,
			npm: () => ({ command: "fixture-npm", args: [] }),
		});
		console.log("publication completed");
	})().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
