const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

async function runner() {
	const { spawnVerified } =
		await import("../../scripts/verification-command.mjs");
	return (source, options = {}) =>
		spawnVerified(process.execPath, ["-e", source], {
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			encoding: "utf8",
			...options,
		});
}

async function gone(pid) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error.code === "ESRCH") return;
			throw error;
		}
		await delay(20);
	}
	assert.fail(`Owned process ${pid} is still present`);
}

test("command monitor preserves arguments, working directory, environment and outputs", async () => {
	const { spawnVerified } =
		await import("../../scripts/verification-command.mjs");
	const directory = mkdtempSync(join(tmpdir(), "chooser-command-"));
	try {
		const literal = "literal $value; `text`";
		const result = spawnVerified(
			process.execPath,
			[
				"-e",
				"process.stdout.write(JSON.stringify([process.cwd(), process.env.CHOOSER_COMMAND_TEST, process.argv[1]])); process.stderr.write('diagnostic'); process.exitCode=7",
				literal,
			],
			{
				timeout: 5_000,
				encoding: "utf8",
				cwd: directory,
				env: { ...process.env, CHOOSER_COMMAND_TEST: literal },
			},
		);
		assert.equal(result.error, undefined);
		assert.equal(result.status, 7);
		assert.deepEqual(JSON.parse(result.stdout), [
			realpathSync(directory),
			literal,
			literal,
		]);
		assert.equal(result.stderr, "diagnostic");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("command monitor returns missing-command failures", async () => {
	const { spawnVerified } =
		await import("../../scripts/verification-command.mjs");
	const result = spawnVerified(
		"/nonexistent/chooser-verification-command",
		[],
		{ timeout: 5_000, encoding: "utf8" },
	);
	assert.equal(result.status, 127);
	assert.match(result.stderr, /Could not start verification command/);
});

test(
	"command deadline kills a resistant process without touching a sibling",
	{ timeout: 20_000 },
	async (t) => {
		const run = await runner();
		const directory = mkdtempSync(join(tmpdir(), "chooser-command-"));
		const ready = join(directory, "ready");
		const sibling = spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			{ detached: true, stdio: "ignore" },
		);
		const exited = once(sibling, "exit");
		t.after(async () => {
			sibling.kill("SIGKILL");
			await exited;
			rmSync(directory, { recursive: true, force: true });
		});
		await once(sibling, "spawn");
		const start = performance.now();
		const result = run(
			`process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.stdout.write('partial output'); process.stderr.write('partial diagnostic\\n'); setInterval(()=>{},1000)`,
			{ timeout: 2_000 },
		);
		const pid = Number(readFileSync(ready, "utf8"));
		assert.equal(result.status, 124);
		assert.match(result.stderr, /timed out/);
		assert.equal(result.stdout, "partial output");
		assert.match(result.stderr, /partial diagnostic/);
		assert(performance.now() - start < 12_000);
		await gone(pid);
		assert.doesNotThrow(() => process.kill(sibling.pid, 0));
	},
);

test(
	"command cleanup kills descendants when their parent exits first",
	{ timeout: 15_000 },
	async () => {
		const run = await runner();
		const descendant =
			"process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000)";
		for (const timedOut of [false, true]) {
			const result = run(
				`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']}); child.once('message',pid=>{process.stdout.write(String(pid)); if(!${timedOut}) process.exit(0)}); setInterval(()=>{},1000);`,
				{ timeout: 2_000 },
			);
			assert.equal(result.error, undefined);
			assert.equal(result.status, timedOut ? 124 : 0);
			const pid = Number(result.stdout);
			assert(Number.isSafeInteger(pid) && pid > 0);
			await gone(pid);
		}
	},
);

test(
	"output limits terminate the monitored command group",
	{ timeout: 15_000 },
	async () => {
		const run = await runner();
		const directory = mkdtempSync(join(tmpdir(), "chooser-command-"));
		const ready = join(directory, "ready");
		try {
			const result = run(
				`process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>process.stdout.write('x'.repeat(65536)),1);`,
				{ maxBuffer: 1024 },
			);
			assert.equal(result.error?.code, "ENOBUFS");
			await gone(Number(readFileSync(ready, "utf8")));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
