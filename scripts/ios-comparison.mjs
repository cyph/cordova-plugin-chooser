import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appleEnvironment } from "./apple.mjs";
import { stageFrozenPackage } from "./fixture-packages.mjs";
import {
	prepareIosSimulatorFixture,
	prepareSimulatorApp,
} from "./ios-simulator.mjs";
import { spawnVerified } from "./verification-command.mjs";
import { checkSimulatorResults } from "./simulator-results.mjs";
import {
	comparisonFiles,
	prepareComparisonDescriptors,
} from "./ios-comparison-packages.mjs";
import {
	comparisonDocuments,
	comparisonError,
	comparisonTimedOut,
	comparisonTimeout,
	createComparisonPlan,
	runComparisonSchedule,
} from "./ios-comparison-model.mjs";
export * from "./ios-comparison-model.mjs";
export {
	checkComparisonPackage,
	prepareComparisonDescriptors,
} from "./ios-comparison-packages.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJSON = (path, value) =>
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const settings = [
	"CODE_SIGNING_ALLOWED=YES",
	"CODE_SIGN_IDENTITY=-",
	"CODE_SIGN_STYLE=Manual",
	"DEVELOPMENT_TEAM=",
	"IPHONEOS_DEPLOYMENT_TARGET=15.0",
];

// Same calling convention as verify.mjs, with a stage deadline around every
// command. The owned-process monitor gets 20 seconds inside that deadline for
// termination/reaping. No command can borrow time from a later arm.
export function comparisonCommandRunner({
	root,
	directory,
	deadline,
	commands,
	env = {},
	now = Date.now,
}) {
	mkdirSync(directory, { recursive: true });
	return (
		command,
		args,
		cwd = root,
		capture = false,
		extraEnv = {},
		options = {},
	) => {
		const available = comparisonTimeout(deadline, now()) - 20_000;
		if (available <= 0)
			throw Object.assign(
				new Error("Comparison stage has no command/cleanup time remaining"),
				{ code: "ETIMEDOUT" },
			);
		const timeout = Math.min(available, options.timeout ?? 20 * 60_000);
		const log = join(
			directory,
			`command-${String(commands.length + 1).padStart(4, "0")}.log`,
		);
		const record = {
			command,
			args,
			cwd,
			timeout,
			deadline,
			log,
			started: now(),
		};
		commands.push(record);
		const result = spawnVerified(command, args, {
			cwd,
			env: { ...process.env, ...env, ...extraEnv },
			encoding: "utf8",
			stdio: "pipe",
			maxBuffer: 64 * 1024 * 1024,
			timeout,
		});
		writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
		const partialOutput =
			Boolean(result.status === 124 || result.signal || result.error) &&
			Boolean(result.stdout?.length || result.stderr?.length);
		Object.assign(record, {
			status: result.status,
			signal: result.signal,
			partialOutput,
			finished: now(),
		});
		if (!capture) {
			process.stdout.write(result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
		}
		try {
			if (result.status === 124 || result.error?.code === "ETIMEDOUT")
				throw Object.assign(new Error(`${command} timed out`), {
					code: "ETIMEDOUT",
					status: 124,
				});
			if (result.error) throw result.error;
			assert.equal(
				result.status,
				0,
				`${command} failed (${result.status ?? result.signal})`,
			);
		} catch (error) {
			error.message += `; ${partialOutput ? "partial output retained; " : ""}see ${log}`;
			throw Object.assign(error, { log, partialOutput });
		}
		return result.stdout?.trim() ?? "";
	};
}

function createApplication({
	root,
	destination,
	framework,
	descriptor,
	run,
	env,
}) {
	assert(!existsSync(destination), "Comparison generated app already exists");
	const cordova = (args, cwd = root) =>
		run(
			process.execPath,
			[join(root, "node_modules/cordova/bin/cordova"), ...args],
			cwd,
			false,
			{
				...env,
				npm_config_ignore_scripts: "true",
				npm_config_offline: "true",
				CORDOVA_TELEMETRY_OFF: "1",
			},
		);
	cordova([
		"create",
		destination,
		"com.cyph.chooser.comparison",
		"ChooserFixture",
	]);
	const platform = stageFrozenPackage(
		destination,
		join(root, "node_modules", framework),
	);
	cordova(
		["platform", "add", `ios@${platform.version}`, "--nosave"],
		destination,
	);
	prepareSimulatorApp(destination);
	const plugin = stageFrozenPackage(destination, descriptor.package);
	cordova(
		["plugin", "add", `${plugin.name}@${plugin.version}`, "--nosave"],
		destination,
	);
	cordova(["prepare", "ios"], destination);
	return platform;
}

export function prepareIosComparison({ root, plan, report, deadline }) {
	assert.equal(
		process.platform,
		"darwin",
		"iOS release comparison requires macOS; native execution is unavailable on Linux",
	);
	report.commands = [];
	let run = comparisonCommandRunner({
		root,
		directory: join(plan.output, "prepare-commands"),
		deadline,
		commands: report.commands,
	});
	const context = prepareComparisonDescriptors({ root, plan, run });
	// Make partial descriptor/source evidence visible even if a later build fails.
	report.context = context;
	const apple = json(join(context.source, "chainman/apple.json"));
	const env = appleEnvironment(apple);
	run = comparisonCommandRunner({
		root,
		directory: join(plan.output, "prepare-commands"),
		deadline,
		commands: report.commands,
		env,
	});
	assert.equal(
		run("/usr/bin/xcodebuild", ["-version"], root, true),
		`Xcode ${apple.xcode}\nBuild version ${apple.build}`,
	);
	assert.equal(
		run(
			"/usr/bin/xcrun",
			["--sdk", "iphonesimulator", "--show-sdk-version"],
			root,
			true,
		),
		apple.iphoneos,
	);
	const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`;
	const runtimes = JSON.parse(
		run("/usr/bin/xcrun", ["simctl", "list", "runtimes", "--json"], root, true),
	).runtimes;
	assert(
		runtimes.some((r) => r.identifier === runtime && r.isAvailable),
		"Pinned runtime unavailable",
	);
	const deviceName = plan.device === "iphone" ? "iPhone 17" : "iPad (A16)";
	const deviceType = JSON.parse(
		run(
			"/usr/bin/xcrun",
			["simctl", "list", "devicetypes", "--json"],
			root,
			true,
		),
	).devicetypes.find((d) => d.name === deviceName);
	assert(deviceType, `Missing simulator device type ${deviceName}`);
	const harness = join(plan.output, "harness");
	cpSync(join(context.source, "tests/ios/simulator"), harness, {
		recursive: true,
	});
	const assets = join(plan.output, "assets");
	mkdirSync(assets);
	const generator = join(plan.output, "generate-assets");
	run("/usr/bin/xcrun", [
		"swiftc",
		"-parse-as-library",
		"-swift-version",
		"5",
		join(harness, "GenerateAssets.swift"),
		"-o",
		generator,
	]);
	run(generator, [assets]);
	const profile = {
		apple,
		runtime,
		deviceName,
		deviceType: deviceType.identifier,
		deploymentTarget: "15.0",
		xcodegen: run("xcodegen", ["--version"], root, true),
		node: process.versions.node,
		framework: json(join(root, "node_modules", plan.framework, "package.json")),
		harness: comparisonFiles(harness),
		assets: comparisonFiles(assets),
		adapter: comparisonFiles(join(context.source, "scripts")).filter(
			(f) =>
				f.name.startsWith("ios-comparison") || f.name === "ios-simulator.mjs",
		),
		seed: {
			method: "system-export",
			files: (plan.documents ?? comparisonDocuments).map((d) => d.name),
			freshSimulatorPerArm: true,
		},
		pluginAsCopy:
			plan.experiment === "metadata-mode"
				? { "rc2-open": false, "rc2-import": true }
				: { rc1: true, rc2: false },
		locale: "en_US",
		language: "en",
	};
	Object.assign(context, { profile, env, assets });
	writeJSON(join(plan.output, "profile.json"), profile);
	for (const release of Object.keys(plan.packages)) {
		const descriptor = context.descriptors[release];
		descriptor.framework = createApplication({
			root,
			destination: descriptor.generated,
			framework: plan.framework,
			descriptor,
			run,
			env,
		});
		prepareIosSimulatorFixture({
			root: context.source,
			generated: descriptor.generated,
			packed: descriptor.package,
			assets,
			directory: descriptor.build,
			alias: plan.framework,
			run,
			env,
			uiOnly: true,
			clean: false,
			adapter: join(context.source, "scripts/ios-comparison-adapter.cjs"),
			comparisonRelease: release === "rc1" ? "rc1" : "rc2",
			buildSettings: settings,
		});
		writeJSON(join(descriptor.evidence, "descriptor.json"), descriptor);
	}
	return context;
}

function armRunner({
	root,
	arm,
	record,
	report,
	deadline,
	directory = "commands",
}) {
	return comparisonCommandRunner({
		root,
		directory: join(arm.directory, directory),
		deadline,
		commands: (record.commands ??= []),
		env: report.context.env,
	});
}
function fixtureFor(arm, report) {
	return report.context.descriptors[
		arm.release === "uikit"
			? report.plan.experiment === "metadata-mode"
				? "rc2-open"
				: "rc2"
			: arm.release
	];
}
function simctl(run, args, root, options) {
	return run("/usr/bin/xcrun", ["simctl", ...args], root, true, {}, options);
}

function executeCase({
	root,
	arm,
	record,
	report,
	deadline,
	item,
	scheme,
	index,
	group,
}) {
	const caseDeadline = Math.min(deadline, Date.now() + 180_000);
	const run = armRunner({ root, arm, record, report, deadline: caseDeadline });
	const name = `${group}-${String(index + 1).padStart(2, "0")}-${item.id.split("/")[1].replace(/\(\)$/, "")}`;
	const bundle = join(arm.directory, `${name}.xcresult`);
	item.artifacts = {
		bundle,
		summary: join(arm.directory, `${name}-summary.json`),
		tests: join(arm.directory, `${name}-tests.json`),
	};
	item.started = Date.now();
	item.deadline = caseDeadline;
	item.status = "running";
	try {
		run(
			"/usr/bin/xcodebuild",
			[
				"test-without-building",
				"-project",
				"ChooserSimulator.xcodeproj",
				"-scheme",
				scheme,
				"-destination",
				`platform=iOS Simulator,id=${record.udid}`,
				"-destination-timeout",
				"60",
				"-parallel-testing-enabled",
				"NO",
				"-test-timeouts-enabled",
				"YES",
				"-default-test-execution-time-allowance",
				"180",
				"-maximum-test-execution-time-allowance",
				"180",
				"-resultBundlePath",
				bundle,
				"-derivedDataPath",
				fixtureFor(arm, report).build + "/derived",
				`-only-testing:${item.id.split("/")[0]}/${item.id.replace(/\(\)$/, "")}`,
				...settings,
				"AppleLanguages=(en)",
				"AppleLocale=en_US",
			],
			fixtureFor(arm, report).build,
			false,
			{ TEST_RUNNER_CHOOSER_COMPARISON: "1" },
			{ timeout: 140_000 },
		);
		item.status = "awaiting-results";
	} catch (error) {
		item.status = comparisonTimedOut(error) ? "timed-out" : "failed";
		item.error = comparisonError(error);
	}
	// Extract exact results even after xcodebuild reports a test failure.
	item.xctestStatus = "not-validated";
	if (existsSync(bundle)) {
		try {
			for (const part of ["summary", "tests"]) {
				const value = JSON.parse(
					run(
						"/usr/bin/xcrun",
						["xcresulttool", "get", "test-results", part, "--path", bundle],
						root,
						true,
						{},
						{ timeout: 10_000 },
					),
				);
				writeJSON(item.artifacts[part], value);
			}
			checkSimulatorResults(
				json(item.artifacts.summary),
				json(item.artifacts.tests),
				[item.id],
			);
			// Keep the validated observation even if execution or collection fails.
			item.xctestStatus = "passed";
			if (item.status === "awaiting-results") item.status = "passed";
		} catch (error) {
			if (item.status !== "timed-out")
				item.status = comparisonTimedOut(error) ? "timed-out" : "failed";
			item.resultError = comparisonError(error);
		}
	} else if (item.status === "awaiting-results") {
		item.status = "failed";
		item.error = { message: "Missing xcresult" };
	}
	item.finished = Date.now();
	try {
		const bundleId =
			scheme === "UIKitControl"
				? "com.cyph.chooser.uikit"
				: "com.cyph.chooser.simulator";
		const container = simctl(
			run,
			["get_app_container", record.udid, bundleId, "data"],
			root,
			{ timeout: 5_000 },
		);
		const events = join(container, "Library/Caches/chooser-fixture-events.log");
		assert(existsSync(events), "Missing case callback event log");
		item.artifacts.events = join(arm.directory, `${name}-events.log`);
		cpSync(events, item.artifacts.events);
	} catch (error) {
		item.eventsError = comparisonError(error);
		if (item.status === "passed") item.status = "failed";
	}
	if (
		report.plan.experiment === "metadata-mode" ||
		report.plan.experiment === "metadata-regression"
	) {
		try {
			item.artifacts.provider = join(arm.directory, `${name}-provider.log`);
			writeFileSync(
				item.artifacts.provider,
				simctl(
					run,
					[
						"spawn",
						record.udid,
						"log",
						"show",
						"--last",
						"4m",
						"--style",
						"compact",
						"--info",
						"--debug",
						"--predicate",
						'subsystem CONTAINS[c] "DocumentManager" OR subsystem CONTAINS[c] "FileProvider" OR eventMessage CONTAINS "CHOOSER_FIXTURE"',
					],
					root,
					{ timeout: 10_000 },
				),
			);
		} catch (error) {
			item.providerError = comparisonError(error);
			if (item.status === "passed") item.status = "failed";
		}
	}
	if (!existsSync(bundle))
		writeJSON(join(arm.directory, `${name}-not-started.json`), item);
}

export function executeIosComparisonArm({
	root,
	arm,
	record,
	report,
	deadline,
	save,
}) {
	const run = armRunner({ root, arm, record, report, deadline });
	const context = report.context;
	const fixture = fixtureFor(arm, report);
	record.udid = simctl(
		run,
		[
			"create",
			`ChooserComparison-${planLabel(report)}-${arm.id}`,
			context.profile.deviceType,
			context.profile.runtime,
		],
		root,
	);
	assert.match(
		record.udid,
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
	save();
	simctl(run, ["boot", record.udid], root);
	simctl(run, ["bootstatus", record.udid, "-b"], root);
	const products = join(
		fixture.build,
		"derived/Build/Products/Debug-iphonesimulator",
	);
	simctl(
		run,
		["install", record.udid, join(products, "ChooserVault.app")],
		root,
	);
	// Activate Files before publishing the provider container, exactly as in
	// the existing system-export harness. This is setup, not a comparison case.
	executeCase({
		root,
		arm,
		record,
		report,
		deadline,
		item: record.setup[0],
		scheme: "UIKitControl",
		index: 0,
		group: "setup",
	});
	save();
	simctl(run, ["launch", record.udid, "com.cyph.chooser.fixtures"], root);
	const container = simctl(
		run,
		["get_app_container", record.udid, "com.cyph.chooser.fixtures", "data"],
		root,
	);
	record.providerContainer = container;
	run(
		process.execPath,
		[
			"-e",
			`const fs=require('node:fs');const p=process.argv[1];const end=Date.now()+60000;const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t);if(JSON.parse(fs.readFileSync(p)).status!=='ready')process.exitCode=1;}else if(Date.now()>=end){clearInterval(t);process.exitCode=1;}},100);`,
			join(container, "Library/Caches/chooser-fixture-ready"),
		],
		root,
		false,
		{},
		{ timeout: 65_000 },
	);
	for (const [index, document] of (
		report.plan.documents ?? comparisonDocuments
	).entries()) {
		const item = record.setup[index + 1];
		executeCase({
			root,
			arm,
			record,
			report,
			deadline,
			item,
			scheme: "UIKitControl",
			index: index + 1,
			group: "setup",
		});
		try {
			assert.deepEqual(
				readFileSync(join(container, "Documents", document.name)),
				readFileSync(join(context.assets, document.name)),
				"System-export seed changed bytes",
			);
		} catch (error) {
			item.status = "failed";
			item.seedError = comparisonError(error);
		}
		save();
	}
	record.sourcesBefore = comparisonFiles(join(container, "Documents"));
	writeJSON(join(arm.directory, `${arm.id}-sources.json`), {
		before: record.sourcesBefore,
	});
	for (const [index, item] of record.cases.entries()) {
		if (Date.now() >= deadline - 20_000) break;
		executeCase({
			root,
			arm,
			record,
			report,
			deadline,
			item,
			scheme: arm.release === "uikit" ? "UIKitControl" : "ChooserUI",
			index,
			group: "case",
		});
		save();
	}
}
const planLabel = (report) => `${report.plan.framework}-${report.plan.device}`;

export function collectIosComparisonArm({
	root,
	arm,
	record,
	report,
	deadline,
}) {
	const run = armRunner({
		root,
		arm,
		record,
		report,
		deadline: deadline - 20_000,
		directory: "evidence-commands",
	});
	const errors = [];
	const attempt = (action) => {
		try {
			action();
		} catch (error) {
			errors.push(error);
		}
	};
	// These run on successful arms as well. Keep raw bundles, callbacks,
	// provider documents, system logs and screenshots before deleting the device.
	if (record.udid) {
		attempt(() =>
			simctl(
				run,
				[
					"io",
					record.udid,
					"screenshot",
					join(arm.directory, `${arm.id}-screen.png`),
				],
				root,
				{ timeout: 5_000 },
			),
		);
		for (const [label, bundle] of [
			["plugin", "com.cyph.chooser.simulator"],
			["control", "com.cyph.chooser.uikit"],
		]) {
			// UIKit-only arms never install the plugin host.
			if (label === "plugin" && arm.release === "uikit") continue;
			attempt(() => {
				const container = simctl(
					run,
					["get_app_container", record.udid, bundle, "data"],
					root,
					{ timeout: 5_000 },
				);
				const source = join(
					container,
					"Library/Caches/chooser-fixture-events.log",
				);
				assert(existsSync(source), `Missing ${label} callback events`);
				cpSync(source, join(arm.directory, `${arm.id}-${label}-events.log`));
			});
		}
		attempt(() =>
			writeFileSync(
				join(arm.directory, `${arm.id}-provider.log`),
				simctl(
					run,
					[
						"spawn",
						record.udid,
						"log",
						"show",
						"--last",
						"2h",
						"--style",
						"compact",
						"--info",
						"--debug",
						"--predicate",
						'subsystem CONTAINS[c] "DocumentManager" OR subsystem CONTAINS[c] "FileProvider" OR eventMessage CONTAINS "CHOOSER_FIXTURE"',
					],
					root,
					{ timeout: 15_000 },
				),
			),
		);
		if (record.providerContainer)
			attempt(() => {
				const documents = join(record.providerContainer, "Documents");
				const after = comparisonFiles(documents);
				writeJSON(join(arm.directory, `${arm.id}-sources.json`), {
					before: record.sourcesBefore ?? null,
					after,
				});
				cpSync(documents, join(arm.directory, "provider-documents"), {
					recursive: true,
				});
				assert.deepEqual(
					after,
					record.sourcesBefore,
					"Selection changed provider originals",
				);
			});
		// Screenshots and hierarchies remain in every raw xcresult on pass and
		// failure. An optional duplicate attachment export must not gate A/B.
		const cleanup = armRunner({
			root,
			arm,
			record,
			report,
			deadline,
			directory: "evidence-commands",
		});
		for (const action of ["shutdown", "delete"])
			attempt(() =>
				simctl(cleanup, [action, record.udid], root, { timeout: 5_000 }),
			);
	}
	writeJSON(join(arm.directory, `${arm.id}-evidence.json`), {
		errors: errors.map(comparisonError),
	});
	if (errors.length)
		throw new AggregateError(
			errors,
			`Evidence collection failed for ${arm.id}: ${errors.map((e) => e.message).join("; ")}`,
		);
}

export async function verifyIosComparison({
	root = repository,
	output,
	framework,
	device,
	experiment = "releases",
	prepare,
	executeArm,
	collectArm,
	now,
} = {}) {
	root = resolve(root);
	output = resolve(
		output ??
			join(
				root,
				".verification/reports",
				`ios-comparison-${framework}-${device}`,
			),
	);
	const plan = createComparisonPlan({ framework, device, output, experiment });
	assert(!existsSync(output), `Comparison output already exists: ${output}`);
	mkdirSync(output, { recursive: true });
	for (const arm of plan.arms) mkdirSync(arm.directory, { recursive: true });
	const save = (report) => {
		writeJSON(join(output, "comparison.json"), report);
		for (const arm of report.arms) {
			const directory = plan.arms.find((a) => a.id === arm.id).directory;
			writeJSON(join(directory, `${arm.id}-summary.json`), arm);
			const missing = join(directory, `${arm.id}-not-started.json`);
			if (
				arm.status === "not-started" ||
				[...arm.setup, ...arm.cases].some((c) => c.status === "not-started")
			)
				writeJSON(missing, {
					status: arm.status,
					reason: arm.reason,
					cases: [...arm.setup, ...arm.cases].filter(
						(c) => c.status === "not-started",
					),
				});
			else if (existsSync(missing)) rmSync(missing);
		}
	};
	const report = await runComparisonSchedule({
		plan,
		now,
		save,
		prepare:
			prepare ?? ((args) => prepareIosComparison({ root, plan, ...args })),
		executeArm:
			executeArm ?? ((args) => executeIosComparisonArm({ root, ...args })),
		collectArm:
			collectArm ?? ((args) => collectIosComparisonArm({ root, ...args })),
	});
	if (report.status !== "passed")
		throw Object.assign(
			new Error(
				`iOS comparison failed; see ${join(output, "comparison.json")}`,
			),
			{ report },
		);
	return report;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		assert(
			[4, 5].includes(process.argv.length),
			"Usage: node scripts/ios-comparison.mjs <cordova-ios7|cordova-ios8> <iphone|ipad> [releases|metadata-mode|metadata-regression]",
		);
		const report = await verifyIosComparison({
			framework: process.argv[2],
			device: process.argv[3],
			experiment: process.argv[4] ?? "releases",
		});
		console.log(
			`Comparison ${report.status}: ${report.plan.output}/comparison.json`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
