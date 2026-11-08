const assert = require("node:assert/strict");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { metadata } = require("../../scripts/ios-comparison-adapter.cjs");
const load = () => import("../../scripts/ios-comparison.mjs");
function temporary(t) {
	const directory = mkdtempSync(join(tmpdir(), "chooser-comparison-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}
function completed(record, index) {
	record.udid = `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
	for (const item of [...record.setup, ...record.cases]) item.status = "passed";
}
async function schedule(options = {}) {
	const m = await load();
	const plan = m.createComparisonPlan({
		framework: "cordova-ios7",
		device: "iphone",
		output: "/tmp/comparison-test",
	});
	const report = await m.runComparisonSchedule({
		plan,
		prepare: () => ({}),
		executeArm: ({ record, arm }) => completed(record, arm.ordinal),
		collectArm: () => {},
		...options,
	});
	return { m, plan, report };
}

test("RC1 integrity pin rejects altered bytes and package name/version are checked", async (t) => {
	const m = await load();
	assert.equal(
		m.rc1.url,
		"https://registry.npmjs.org/cordova-plugin-chooser/-/cordova-plugin-chooser-2.0.0-rc.1.tgz",
	);
	assert.equal(
		m.rc1.integrity,
		"sha512-8NYV/y8xT2rnHvM3XuC/beFFBRhWgLfvjlln+0kai/FH+5pXm/6E497c4L0u7+BSc/h073WnyAw+woq5oDF4wg==",
	);
	assert.throws(
		() => m.comparisonIntegrity(Buffer.from("substitute"), m.rc1.integrity),
		/integrity mismatch/,
	);
	const hash = m.comparisonIntegrity(Buffer.from("bytes"));
	assert.equal(m.comparisonIntegrity(Buffer.from("bytes"), hash), hash);
	assert.throws(() => m.comparisonIntegrity(Buffer.from("byteS"), hash));
	const directory = temporary(t);
	mkdirSync(join(directory, "src/ios"), { recursive: true });
	writeFileSync(join(directory, "plugin.xml"), "");
	writeFileSync(join(directory, "chooser.js"), "");
	for (const [name, version, good] of [
		["cordova-plugin-chooser", "2.0.0-rc.1", true],
		["other", "2.0.0-rc.1", false],
		["cordova-plugin-chooser", "2.0.0-rc.2", false],
	]) {
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({ name, version, main: "chooser.js" }),
		);
		if (good) m.checkComparisonPackage(directory, "rc1");
		else assert.throws(() => m.checkComparisonPackage(directory, "rc1"));
	}
});

test("metadata adapter preserves selection and handles only the release-specific cancellation", async () => {
	class CancellationError extends Error {}
	const file = { name: "fixture-json.json" };
	for (const release of ["rc1", "rc2"]) {
		let received;
		const chooser = {
			CancellationError,
			getFileMetadata: async (arg) => {
				received = arg;
				return file;
			},
		};
		assert.deepEqual(await metadata(chooser, release, "application/json"), {
			outcome: "selected",
			file,
		});
		assert.deepEqual(
			received,
			release === "rc1" ? "application/json" : { accept: "application/json" },
		);
	}
	assert.deepEqual(
		await metadata({ getFileMetadata: async () => undefined }, "rc1", "*/*"),
		{ outcome: "canceled" },
	);
	assert.deepEqual(
		await metadata(
			{
				CancellationError,
				getFileMetadata: async () => {
					throw new CancellationError();
				},
			},
			"rc2",
			"*/*",
		),
		{ outcome: "canceled" },
	);
	for (const release of ["rc1", "rc2"]) {
		for (const error of [
			new Error("provider failed"),
			Object.assign(new Error("lookalike"), { code: "CANCELLED" }),
			"RESULT_CANCELED",
		]) {
			await assert.rejects(
				metadata(
					{
						CancellationError,
						getFileMetadata: async () => {
							throw error;
						},
					},
					release,
					"*/*",
				),
				(e) => e === error,
			);
		}
	}
	await assert.rejects(
		metadata(
			{
				CancellationError,
				getFileMetadata: async () => {
					throw new CancellationError();
				},
			},
			"rc1",
			"*/*",
		),
		CancellationError,
	);
	await assert.rejects(
		metadata(
			{ CancellationError, getFileMetadata: async () => undefined },
			"rc2",
			"*/*",
		),
		/Invalid metadata/,
	);
});

test("dirty tracked source is rejected before resolving, archiving, packing or downloading", async () => {
	const m = await load();
	const calls = [];
	assert.throws(
		() =>
			m.prepareComparisonDescriptors({
				root: "/repo",
				plan: { output: "/unused" },
				run: (cmd, args) => {
					calls.push([cmd, args]);
					return " M www/chooser.js";
				},
			}),
		/clean tracked source/,
	);
	assert.deepEqual(calls, [
		["git", ["status", "--porcelain", "--untracked-files=no"]],
	]);
});

test("command deadlines reject before starting and preserve owned-command output", async (t) => {
	const m = await load(),
		directory = temporary(t),
		commands = [];
	const run = m.comparisonCommandRunner({
		root: directory,
		directory,
		deadline: Date.now() + 60000,
		commands,
	});
	assert.equal(
		run(
			process.execPath,
			["-e", "process.stdout.write('bounded')"],
			directory,
			true,
		),
		"bounded",
	);
	assert.equal(commands[0].status, 0);
	assert(commands[0].timeout <= 40000);
	assert.equal(readFileSync(commands[0].log, "utf8"), "bounded");
	const expired = m.comparisonCommandRunner({
		root: directory,
		directory,
		deadline: 2000,
		commands,
		now: () => 2000,
	});
	assert.throws(() => expired("must-not-run", []), { code: "ETIMEDOUT" });
	assert.equal(commands.length, 1);
});

test("four partitions isolate descriptors, apps, builds, evidence, and the exact six-arm matrix", async () => {
	const m = await load();
	assert.equal(m.comparisonPartitions.length, 4);
	const paths = [];
	for (const partition of m.comparisonPartitions) {
		const plan = m.createComparisonPlan({
			...partition,
			output: `/tmp/${partition.framework}-${partition.device}`,
		});
		assert.deepEqual(
			plan.arms.map((a) => a.release),
			["uikit", "rc1", "rc2", "rc2", "rc1", "uikit"],
		);
		for (const p of Object.values(plan.packages))
			paths.push(p.generated, p.build, p.evidence);
		for (const arm of plan.arms) {
			paths.push(arm.directory);
			assert.equal(arm.setup.length, 7);
			assert.equal(arm.cases.length, arm.release === "uikit" ? 6 : 7);
			assert(!arm.cases.some((id) => /Swipe|Scoped|Uri|PickerTests/.test(id)));
			if (arm.release === "uikit")
				assert(
					arm.cases.every((id) =>
						/test(Import|Open)Original(JSON|CSV|PDF)/.test(id),
					),
				);
			else
				assert(arm.cases.includes("ChooserUITests/testCancelPromiseReopen()"));
		}
	}
	assert.equal(new Set(paths).size, paths.length);
	assert.throws(() =>
		m.createComparisonPlan({
			framework: "cordova-ios9",
			device: "iphone",
			output: "/tmp/x",
		}),
	);
});

test("fixed stage/deadline budget is at most 340 minutes including evidence, with 20 workflow headroom", async () => {
	const m = await load();
	let time = 0;
	const seen = [];
	const plan = m.createComparisonPlan({
		framework: "cordova-ios8",
		device: "ipad",
		output: "/tmp/budget",
	});
	const report = await m.runComparisonSchedule({
		plan,
		now: () => time,
		prepare: ({ deadline }) => {
			assert.equal(deadline, 35 * 60000);
			time = deadline - 1;
			return {};
		},
		executeArm: ({ arm, record, deadline }) => {
			assert.equal(deadline - time, arm.minutes * 60000);
			seen.push(arm.id);
			completed(record, arm.ordinal);
			time = deadline - 1;
		},
		collectArm: ({ deadline }) => {
			assert.equal(deadline - time, 150000);
			time = deadline - 1;
		},
	});
	assert.equal(report.status, "passed");
	assert(time <= 340 * 60000);
	assert.equal(seen.length, 6);
	assert.equal(
		m.comparisonBudgets.workflowMinutes - m.comparisonBudgets.jobMinutes,
		20,
	);
	assert.equal(m.comparisonBudgets.caseSeconds, 180);
	assert.equal(m.comparisonTimeout(5000, 2000, 1000), 1000);
	assert.throws(() => m.comparisonTimeout(2000, 2000), { code: "ETIMEDOUT" });
});

test("a failed/timed out arm and failed diagnostics retain every later arm without retries", async () => {
	const attempted = [],
		collected = [];
	const { report } = await schedule({
		executeArm: ({ arm, record }) => {
			attempted.push(arm.id);
			if (arm.ordinal === 2) {
				record.cases[0].status = "timed-out";
				throw Object.assign(new Error("deadline"), { code: "ETIMEDOUT" });
			}
			completed(record, arm.ordinal);
		},
		collectArm: ({ arm }) => {
			collected.push(arm.id);
			if (arm.ordinal === 3) throw new Error("export failed");
		},
	});
	assert.equal(report.status, "failed");
	assert.equal(report.arms[1].status, "timed-out");
	assert.equal(report.arms[1].cases[1].status, "not-started");
	assert.equal(report.arms[2].evidence.status, "failed");
	assert.equal(report.arms[5].status, "passed");
	assert.deepEqual(attempted, collected);
	assert.equal(attempted.length, 6);
});

test("shared preparation failure creates comparison.json and explicit missing arms before throwing", async (t) => {
	const m = await load();
	const output = join(temporary(t), "report");
	let called = false;
	await assert.rejects(
		m.verifyIosComparison({
			framework: "cordova-ios7",
			device: "iphone",
			output,
			prepare: () => {
				throw new Error("bad integrity");
			},
			executeArm: () => {
				called = true;
			},
		}),
		/comparison failed/,
	);
	assert.equal(called, false);
	const report = JSON.parse(readFileSync(join(output, "comparison.json")));
	assert.equal(report.status, "failed");
	assert.equal(report.prepare.status, "failed");
	assert.equal(report.arms.length, 6);
	assert(
		report.arms.every(
			(a) =>
				a.status === "not-started" &&
				a.cases.every((c) => c.status === "not-started"),
		),
	);
	for (const arm of report.plan.arms)
		assert(existsSync(join(arm.directory, `${arm.id}-not-started.json`)));
	await assert.rejects(
		m.verifyIosComparison({
			framework: "cordova-ios7",
			device: "iphone",
			output,
		}),
		/already exists/,
	);
});

test("exact result manifest rejects failed, skipped, missing, duplicate, unexpected and reordered cases/arms", async () => {
	const { m, plan, report } = await schedule();
	m.checkComparisonResults(report, plan);
	for (const mutate of [
		(r) => r.arms.pop(),
		(r) => r.arms.push(r.arms[0]),
		(r) => r.arms.reverse(),
		(r) => r.arms[0].cases.pop(),
		(r) => r.arms[0].cases.push(r.arms[0].cases[0]),
		(r) => r.arms[0].cases.reverse(),
		(r) => r.arms[0].setup.pop(),
		(r) => (r.arms[0].cases[0].id = "ChooserUITests/testSwipePromiseReopen()"),
		(r) => (r.arms[0].cases[0].status = "not-started"),
		(r) => (r.arms[0].cases[0].status = "failed"),
		(r) => (r.arms[0].cases[0].status = "skipped"),
		(r) => (r.arms[0].evidence.status = "failed"),
		(r) => (r.arms[1].udid = r.arms[0].udid),
		(r) => (r.plan.budgets.caseSeconds = 999),
	]) {
		const copy = structuredClone(report);
		mutate(copy);
		assert.throws(() => m.checkComparisonResults(copy, plan));
	}
});

test("UI-only RC1 scheme excludes native contracts; native selection builds and runs without provider fixtures", async (t) => {
	const { prepareIosSimulatorFixture, simulatorNativeOnly } =
		await import("../../scripts/ios-simulator.mjs");
	assert.equal(
		simulatorNativeOnly({
			chooser: ["ChooserPickerTests/testExample()"],
			control: [],
		}),
		true,
	);
	assert.equal(
		simulatorNativeOnly({
			chooser: ["ChooserUITests/testJSON()"],
			control: [],
		}),
		false,
	);
	assert.equal(simulatorNativeOnly({ chooser: [], control: [] }), false);
	const base = temporary(t),
		root = join(__dirname, "../..");
	const generated = join(base, "generated");
	mkdirSync(join(generated, "platforms/ios/www"), { recursive: true });
	mkdirSync(join(generated, "platforms/ios/ChooserFixture"), {
		recursive: true,
	});
	writeFileSync(
		join(generated, "platforms/ios/ChooserFixture/config.xml"),
		"<widget/>",
	);
	const commands = [];
	const run = (cmd, args) => {
		commands.push({ cmd, args });
		return "";
	};
	for (const nativeOnly of [false, true]) {
		const directory = join(base, nativeOnly ? "native" : "rc1");
		prepareIosSimulatorFixture({
			root,
			generated,
			packed: root,
			directory,
			alias: "cordova-ios7",
			run,
			env: {},
			uiOnly: !nativeOnly,
			nativeOnly,
			clean: false,
			...(!nativeOnly
				? {
						adapter: join(root, "scripts/ios-comparison-adapter.cjs"),
						comparisonRelease: "rc1",
					}
				: {}),
		});
		const spec = JSON.parse(readFileSync(join(directory, "project.json")));
		if (nativeOnly) {
			assert.deepEqual(Object.keys(spec.schemes), ["ChooserNative"]);
			assert(
				!spec.targets.UIKitControl &&
					!spec.targets.ChooserVault &&
					!spec.targets.ChooserUITests,
			);
		} else {
			assert(!spec.targets.ChooserPickerTests);
			assert.deepEqual(spec.schemes.ChooserUI.test.targets, ["ChooserUITests"]);
			assert.match(
				readFileSync(join(directory, "www/index.html"), "utf8"),
				/iosComparisonRelease = "rc1"/,
			);
		}
	}
	const nativeCommands = commands
		.filter((c) => c.cmd === "/usr/bin/xcodebuild")
		.slice(-1);
	assert.equal(nativeCommands.length, 1);
	assert(nativeCommands[0].args.includes("ChooserNative"));
});
