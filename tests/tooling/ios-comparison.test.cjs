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
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { metadata } = require("../../scripts/ios-comparison-adapter.cjs");
const load = () => import("../../scripts/ios-comparison.mjs");
const loadModel = () => import("../../scripts/ios-comparison-model.mjs");
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

function metadataModeFixture(m) {
	const plan = m.createComparisonPlan({
		framework: "cordova-ios8",
		device: "ipad",
		output: "/tmp/comparison-metadata-mode",
		experiment: "metadata-mode",
	});
	const baseIntegrity = m.comparisonIntegrity(Buffer.from("unmodified RC2"));
	const context = {
		commit: "a".repeat(40),
		tree: "b".repeat(40),
		sourceIntegrity: m.comparisonIntegrity(Buffer.from("source archive")),
		descriptors: Object.fromEntries(
			Object.entries(plan.packages).map(([release, paths]) => [
				release,
				{
					...paths,
					integrity: paths.metadataAsCopy
						? m.comparisonIntegrity(Buffer.from("metadata-only import"))
						: baseIntegrity,
					...(paths.metadataAsCopy
						? {
								experiment: {
									kind: "metadata-import",
									baseIntegrity,
									changedFile: "src/ios/Chooser.swift",
									original: "asCopy: false",
									replacement: "asCopy: request.mode == .metadata",
								},
							}
						: {}),
				},
			]),
		),
	};
	return { plan, context };
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
	assert.equal(commands[0].partialOutput, false);
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

test("failed and timed-out commands link retained output through serialized errors", async (t) => {
	const m = await load(),
		directory = temporary(t),
		commands = [];
	const run = m.comparisonCommandRunner({
		root: directory,
		directory,
		deadline: Date.now() + 60000,
		commands,
	});
	for (const timedOut of [false, true]) {
		assert.throws(
			() =>
				run(
					process.execPath,
					[
						"-e",
						"process.stdout.write('retained diagnostic');" +
							(timedOut ? "setInterval(()=>{},1000)" : "process.exitCode=7"),
					],
					directory,
					true,
					{},
					{ timeout: 1000 },
				),
			(error) => {
				const command = commands.at(-1);
				assert.equal(command.status, timedOut ? 124 : 7);
				assert.equal(command.partialOutput, timedOut);
				assert.equal(error.log, command.log);
				assert.equal(error.partialOutput, timedOut);
				assert(error.message.includes(command.log));
				assert.equal(
					error.message.includes("partial output retained"),
					timedOut,
				);
				assert.match(readFileSync(error.log, "utf8"), /retained diagnostic/);
				assert.equal(m.comparisonTimedOut(error), timedOut);
				const serialized = JSON.parse(JSON.stringify(m.comparisonError(error)));
				assert.equal(serialized.log, command.log);
				assert.equal(serialized.partialOutput, timedOut);
				if (timedOut) assert.equal(serialized.code, "ETIMEDOUT");
				return true;
			},
		);
	}
});

test("validated XCTest observations survive collection failures without promoting unsuccessful cases", async (t) => {
	const m = await load();
	for (const scenario of [
		{ name: "passing XCTest, failed callback snapshot", eventsFailure: true },
		{
			name: "passing XCTest, timed-out arm diagnostics",
			diagnosticTimeout: true,
		},
		{ name: "failed XCTest", result: "Failed" },
		{ name: "missing XCTest bundle", missing: true },
		{ name: "passing XCTest, failed execution", executionStatus: 65 },
		{ name: "passing XCTest, timed-out execution", executionStatus: 124 },
	]) {
		await t.test(scenario.name, async (t) => {
			const directory = temporary(t),
				output = join(directory, "report"),
				container = join(directory, "container"),
				assets = join(directory, "assets"),
				target = "UIKitControlTests/testCancel()";
			for (const path of [
				assets,
				join(container, "Documents"),
				join(container, "Library/Caches"),
			])
				mkdirSync(path, { recursive: true });
			for (const { name } of m.comparisonDocuments) {
				writeFileSync(join(assets, name), name);
				writeFileSync(join(container, "Documents", name), name);
			}
			writeFileSync(
				join(container, "Library/Caches/chooser-fixture-events.log"),
				"callbacks",
			);
			let current;
			// Stub only the process boundary: exercise the real case, command,
			// collection and schedule reporters without invoking Apple tools.
			const spawn = t.mock.method(
				childProcess,
				"spawnSync",
				(monitor, argv) => {
					assert.equal(monitor, "python3");
					const [, , command, ...args] = argv;
					let stdout = "",
						status = 0;
					if (command === "/usr/bin/xcodebuild") {
						current =
							args
								.find((a) => a.startsWith("-only-testing:"))
								.split("/")
								.slice(-2)
								.join("/") + "()";
						if (!(current === target && scenario.missing))
							mkdirSync(args[args.indexOf("-resultBundlePath") + 1]);
						if (current === target) status = scenario.executionStatus ?? 0;
					} else if (
						command === "/usr/bin/xcrun" &&
						args[0] === "xcresulttool"
					) {
						const result =
							current === target ? (scenario.result ?? "Passed") : "Passed";
						stdout = JSON.stringify(
							args[3] === "summary"
								? {
										totalTestCount: 1,
										passedTests: result === "Passed" ? 1 : 0,
										failedTests: result === "Passed" ? 0 : 1,
										skippedTests: 0,
									}
								: {
										testNodes: [
											{
												nodeType: "Test Case",
												nodeIdentifier: current,
												result,
											},
										],
									},
						);
					} else if (command === "/usr/bin/xcrun" && args[0] === "simctl") {
						if (args[1] === "create")
							stdout = "00000000-0000-0000-0000-000000000001";
						if (args[1] === "get_app_container") {
							stdout = container;
							if (
								current === target &&
								args[3] === "com.cyph.chooser.uikit" &&
								scenario.eventsFailure
							)
								status = 124;
						}
						if (args[1] === "spawn" && scenario.diagnosticTimeout) {
							stdout = "partial provider diagnostic";
							status = 124;
						}
					} else {
						assert.equal(command, process.execPath); // Provider readiness poll.
					}
					return { status, signal: null, stdout, stderr: "" };
				},
			);
			syncBuiltinESMExports();
			t.after(() => {
				spawn.mock.restore();
				syncBuiltinESMExports();
			});
			await assert.rejects(
				m.verifyIosComparison({
					output,
					framework: "cordova-ios8",
					device: "iphone",
					prepare: () => ({
						env: {},
						assets,
						profile: { deviceType: "fake", runtime: "fake" },
						descriptors: { rc2: { build: directory } },
					}),
					executeArm: (args) =>
						args.arm.ordinal === 1
							? m.executeIosComparisonArm({ root: directory, ...args })
							: completed(args.record, args.arm.ordinal),
					collectArm: (args) => {
						if (args.arm.ordinal === 1)
							m.collectIosComparisonArm({ root: directory, ...args });
					},
				}),
				/iOS comparison failed/,
			);
			const report = JSON.parse(readFileSync(join(output, "comparison.json"))),
				arm = report.arms[0],
				item = arm.setup[0];
			assert.equal(report.status, "failed");
			assert.equal(
				item.xctestStatus,
				scenario.result || scenario.missing ? "not-validated" : "passed",
			);
			assert.equal(
				item.status,
				scenario.diagnosticTimeout
					? "passed"
					: scenario.executionStatus === 124
						? "timed-out"
						: "failed",
			);
			assert.equal(
				arm.status,
				scenario.diagnosticTimeout ? "passed" : "failed",
			);
			assert.equal(
				arm.evidence.status,
				scenario.diagnosticTimeout ? "failed" : "passed",
			);
			assert(
				[...arm.setup.slice(1), ...arm.cases].every(
					(other) => other.status === "passed",
				),
			);
			assert.equal(report.arms[5].status, "passed");
			if (scenario.result)
				assert.match(item.resultError.message, /Unsuccessful case/);
			if (scenario.missing)
				assert.equal(item.error.message, "Missing xcresult");
			if (scenario.eventsFailure) {
				assert.equal(item.error, undefined);
				assert.equal(item.resultError, undefined);
				assert.equal(item.eventsError.code, "ETIMEDOUT");
				assert.equal(item.eventsError.partialOutput, true);
				assert.equal(readFileSync(item.eventsError.log, "utf8"), container);
			}
			if (scenario.diagnosticTimeout) {
				const [error] = arm.evidence.error.errors;
				assert.equal(error.code, "ETIMEDOUT");
				assert.equal(error.partialOutput, true);
				assert.equal(
					readFileSync(error.log, "utf8"),
					"partial provider diagnostic",
				);
				assert.deepEqual(
					JSON.parse(
						readFileSync(join(output, "arms/01-uikit/01-uikit-evidence.json")),
					).errors,
					[error],
				);
			}
		});
	}
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

test("release experiment aliases preserve the original serialized plan and runner defaults", async (t) => {
	const m = await load();
	const options = {
		framework: "cordova-ios8",
		device: "ipad",
		output: "/tmp/comparison-default",
	};
	const original = m.createComparisonPlan(options);
	assert.deepEqual(Object.keys(original), [
		"schema",
		"framework",
		"device",
		"output",
		"budgets",
		"packages",
		"arms",
	]);
	assert.equal(
		JSON.stringify(
			m.createComparisonPlan({ ...options, experiment: "releases" }),
		),
		JSON.stringify(original),
	);
	for (const experiment of [null, "", "metadata", "other"])
		assert.throws(
			() => m.createComparisonPlan({ ...options, experiment }),
			/Unexpected comparison experiment/,
		);
	for (const experiment of [undefined, "releases"]) {
		const output = join(temporary(t), "report");
		const report = await m.verifyIosComparison({
			...options,
			output,
			...(experiment === undefined ? {} : { experiment }),
			prepare: () => ({}),
			executeArm: ({ record, arm }) => completed(record, arm.ordinal),
			collectArm: () => {},
		});
		assert.equal(report.status, "passed");
		assert.deepEqual(
			report.plan,
			m.createComparisonPlan({ ...options, output }),
		);
		assert.deepEqual(
			JSON.parse(readFileSync(join(output, "comparison.json"))).plan,
			report.plan,
		);
	}
});

test("metadata-mode fixes two reversed PNG repetitions with isolated variant descriptors", async () => {
	const m = await loadModel();
	const paths = [];
	for (const partition of m.comparisonPartitions) {
		const plan = m.createComparisonPlan({
			...partition,
			output: `/tmp/metadata-mode-${partition.framework}-${partition.device}`,
			experiment: "metadata-mode",
		});
		assert.equal(plan.experiment, "metadata-mode");
		assert.deepEqual(plan.documents, [
			{ format: "Image", name: "fixture-image.png" },
		]);
		assert.deepEqual(plan.budgets, m.comparisonBudgets);
		assert.deepEqual(Object.keys(plan.packages), ["rc2-open", "rc2-import"]);
		for (const [release, descriptor] of Object.entries(plan.packages)) {
			assert.equal(descriptor.release, release);
			assert.equal(descriptor.comparisonRelease, "rc2");
			assert.equal(descriptor.metadataAsCopy, release === "rc2-import");
			for (const field of ["directory", "generated", "build", "evidence"])
				paths.push(descriptor[field]);
		}
		assert.deepEqual(
			plan.arms.map((arm) => arm.id),
			[
				"01-uikit",
				"02-rc2-open",
				"03-rc2-import",
				"04-rc2-import",
				"05-rc2-open",
				"06-uikit",
			],
		);
		assert.deepEqual(
			plan.arms.map((arm) => arm.release),
			["uikit", "rc2-open", "rc2-import", "rc2-import", "rc2-open", "uikit"],
		);
		assert.deepEqual(
			plan.arms.map((arm) => arm.cases),
			[
				[
					"UIKitControlTests/testImportOriginalImage()",
					"UIKitControlTests/testOpenOriginalImage()",
				],
				["ChooserUITests/testImage()"],
				["ChooserUITests/testImage()"],
				["ChooserUITests/testImage()"],
				["ChooserUITests/testImage()"],
				[
					"UIKitControlTests/testOpenOriginalImage()",
					"UIKitControlTests/testImportOriginalImage()",
				],
			],
		);
		for (const [index, arm] of plan.arms.entries()) {
			assert.equal(arm.ordinal, index + 1);
			assert.equal(arm.minutes, arm.release === "uikit" ? 45 : 50);
			assert.deepEqual(arm.setup, [
				"UIKitControlTests/testCancel()",
				"UIKitControlTests/testSeedImage()",
			]);
			paths.push(arm.directory);
		}
		// Neither repetitions nor separately created plans share mutable manifests.
		plan.documents[0].name = "changed";
		plan.arms[0].setup.pop();
		plan.arms[0].cases.reverse();
		assert.equal(plan.arms[1].setup.length, 2);
		assert.equal(
			plan.arms[5].cases[0],
			"UIKitControlTests/testOpenOriginalImage()",
		);
		assert.equal(m.comparisonDocuments[3].name, "fixture-image.png");
	}
	assert.equal(new Set(paths).size, paths.length);
});

test("metadata-mode retains provenance, deadlines and failed PNG outcomes without retries", async () => {
	const m = await loadModel();
	for (const status of ["passed", "failed", "timed-out", "not-started"]) {
		const { plan, context } = metadataModeFixture(m);
		let time = 0;
		const attempted = [],
			collected = [];
		const report = await m.runComparisonSchedule({
			plan,
			now: () => time,
			prepare: ({ deadline }) => {
				assert.equal(deadline, 35 * 60000);
				time = deadline - 1;
				return context;
			},
			executeArm: ({ arm, record, deadline }) => {
				assert.equal(deadline - time, arm.minutes * 60000);
				attempted.push(arm.id);
				completed(record, arm.ordinal);
				if (arm.ordinal === 2) record.cases[0].status = status;
				time = deadline - 1;
			},
			collectArm: ({ arm, deadline }) => {
				assert.equal(deadline - time, 150000);
				collected.push(arm.id);
				time = deadline - 1;
			},
		});
		assert.equal(report.status, status === "passed" ? "passed" : "failed");
		assert.equal(report.arms[1].cases[0].status, status);
		assert.equal(report.arms[5].status, "passed");
		assert.deepEqual(
			attempted,
			plan.arms.map((arm) => arm.id),
		);
		assert.deepEqual(collected, attempted);
		assert(time <= 340 * 60000);
		assert.equal(report.plan.budgets.caseSeconds, 180);
		const serialized = JSON.parse(JSON.stringify(report));
		assert.deepEqual(serialized.plan, plan);
		assert.deepEqual(serialized.context, context);
		assert.deepEqual(
			serialized.arms.map((arm) => arm.release),
			plan.arms.map((arm) => arm.release),
		);
	}
});

test("metadata-mode exact results reject variant substitution, reused stores and incomplete observations", async () => {
	const m = await loadModel();
	const { plan, context } = metadataModeFixture(m);
	const report = await m.runComparisonSchedule({
		plan,
		prepare: () => context,
		executeArm: ({ record, arm }) => completed(record, arm.ordinal),
		collectArm: () => {},
	});
	m.checkComparisonResults(report, plan);
	for (const mutate of [
		(r) => r.arms.pop(),
		(r) => r.arms.push(r.arms[0]),
		(r) => r.arms.reverse(),
		(r) => (r.arms[1].release = "rc2-import"),
		(r) => (r.arms[2].release = "rc2"),
		(r) => (r.arms[2].udid = r.arms[1].udid),
		(r) => r.arms[1].cases.pop(),
		(r) => r.arms[1].cases.push(r.arms[1].cases[0]),
		(r) => (r.arms[1].cases[0].id = "ChooserUITests/testPDF()"),
		(r) => (r.arms[1].cases[0].status = "failed"),
		(r) => (r.arms[1].cases[0].status = "timed-out"),
		(r) => (r.arms[1].cases[0].status = "skipped"),
		(r) => r.arms[5].cases.reverse(),
		(r) => r.arms[0].setup.pop(),
		(r) => (r.arms[2].evidence.status = "failed"),
		(r) => (r.plan.packages["rc2-import"].metadataAsCopy = false),
		(r) => delete r.context.descriptors["rc2-import"],
		(r) =>
			(r.context.descriptors["rc2-import"] = r.context.descriptors["rc2-open"]),
		(r) => (r.context.descriptors["rc2-import"].metadataAsCopy = false),
		(r) => (r.context.descriptors["rc2-open"].comparisonRelease = "rc2-open"),
		(r) =>
			(r.context.descriptors["rc2-import"].build =
				r.context.descriptors["rc2-open"].build),
	]) {
		const copy = structuredClone(report);
		mutate(copy);
		assert.throws(() => m.checkComparisonResults(copy, plan));
	}
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
