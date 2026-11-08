const assert = require("node:assert/strict");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const apple = require("../../chainman/apple.json");
const { version } = require("../../package.json");
const sha = "a".repeat(40);
const nativeCases = [
	"testAdaptiveDismissalAndStaleCallbacks",
	"testResetAndDuplicateSelectionCannotSettleANewerRequest",
	"testMovieWildcardIncludesMP4AndQuickTime",
	"testSignalCancellationIdentityAndImmediateReopen",
	"testDirectDataSessionsAreLazyBoundedAndCancelable",
	"testManagedCopySurvivesResetAndReadsPositionally",
	"testNativeOptionValidationAndMetadataCountLimit",
	"testPhotoPickerConfigurationAndCancellation",
	"testPhotoMetadataDoesNotLoadContentsAndProviderURLIsConsumedInHandler",
].map((name) => `ChooserPickerTests/${name}()`);
const bridgeCases = ["ChooserBridgeTests/testCordovaBridgeRoundTrip()"];
const requiredCases = [...nativeCases, ...bridgeCases];
const documentFormats = ["JSON", "CSV", "PDF", "Image", "MP4", "MOV"];
const chooserUICases = [
	...documentFormats.map((format) => `ChooserUITests/test${format}()`),
	...[
		"testCancelPromiseReopen",
		"testCancelScopedReopen",
		"testSwipePromiseReopen",
		"testSwipeScopedReopen",
	].map((name) => `ChooserUITests/${name}()`),
];
const controlCases = [
	...documentFormats.map((format) => `UIKitControlTests/test${format}()`),
	"UIKitControlTests/testCancel()",
	"UIKitControlTests/testSwipe()",
	"UIKitControlTests/testPlainSheetSwipe()",
	"UIKitControlTests/testSystemDelegateSwipe()",
];
const api = Promise.all([
	import("../../scripts/qualification.mjs"),
	import("../../scripts/simulator-results.mjs"),
]);

async function fixture(t) {
	const [qualification, simulator] = await api;
	const { requiredChecks, simulatorPartitionChecks, aggregateReports } =
		qualification;
	const directory = mkdtempSync(join(tmpdir(), "chooser-partitions-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const jobs = Object.fromEntries(
		[
			"portable",
			"android",
			"android-failures",
			"ios",
			"ios-modern",
			"ios-simulator",
			"capacitor-android",
		].map((job) => [job, { result: "success" }]),
	);
	const report = (lane, checks) => ({
		schema: 1,
		lane,
		commit: sha,
		status: "passed",
		checks: [...checks],
		package: { version, integrity: "sha512-YWJjZA==" },
		commands: [{ status: 0 }],
		...(lane === "ios-simulator"
			? { simulator: simulator.simulatorManifest("required") }
			: {}),
	});
	const other = Object.entries(requiredChecks)
		.filter(([lane]) => lane !== "ios-simulator")
		.map(([lane, checks]) => report(lane, checks));
	const parts = simulator.simulatorPartitions.map((partition, index) => ({
		...report("ios-simulator", simulatorPartitionChecks(partition)),
		partition: { ...partition },
		simulator: simulator.simulatorManifest("required", [partition]),
		toolchain: {
			apple: { ...apple },
			simulators: [
				{
					alias: partition.framework,
					deviceName:
						partition.device === "iphone" ? "iPhone 17" : "iPad (A16)",
					udid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
					runtime: `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`,
				},
			],
		},
	}));
	const save = (reports) => {
		rmSync(directory, { recursive: true, force: true });
		reports.forEach((value, index) => {
			const destination = join(directory, String(index));
			mkdirSync(destination, { recursive: true });
			writeFileSync(
				join(destination, "qualification.json"),
				JSON.stringify(value),
			);
		});
	};
	const run = (reports = [...other, ...parts], results = jobs) => {
		save(reports);
		return aggregateReports(directory, sha, results);
	};
	return { ...qualification, ...simulator, other, parts, jobs, run, report };
}

test("the local full suite preserves all 148 cases and partition arguments cannot narrow it", async (t) => {
	const f = await fixture(t);
	assert.equal(f.simulatorPartitions.length, 4);
	for (const partition of f.simulatorPartitions)
		assert.deepEqual(
			f.simulatorPartitionOptions([partition.framework, partition.device]),
			partition,
		);
	for (const args of [
		[],
		["cordova-ios7"],
		["cordova-ios7", "iphone", "--provider-only"],
		["cordova-ios7", "iphone", "--dismissal-only"],
		["cordova-ios7", "iphone", "--investigation-only", "--provider-only"],
		["cordova-ios9", "iphone"],
		["cordova-ios7", "../ipad"],
		["cordova-ios7", "iPhone"],
	])
		assert.throws(() => f.simulatorPartitionOptions(args));
	const release = f.simulatorSelection(false);
	assert.deepEqual(release.control, controlCases);
	assert.deepEqual(release.chooser, [...requiredCases, ...chooserUICases]);
	assert.equal(
		(release.control.length + release.chooser.length + 7) *
			f.simulatorPartitions.length,
		148,
	);
});

test("explicit manifests split 40 required and 80 UI cases disjointly and exhaustively", async (t) => {
	const f = await fixture(t);
	let requiredCount = 0;
	let investigationCount = 0;
	let fullCount = 0;
	for (const partition of f.simulatorPartitions) {
		const full = f.simulatorPartitionSelection(partition, "full");
		const required = f.simulatorPartitionSelection(partition, "required");
		const investigation = f.simulatorPartitionSelection(
			partition,
			"investigation",
		);
		assert.deepEqual(required, { control: [], chooser: requiredCases });
		assert.deepEqual(investigation, {
			control: controlCases,
			chooser: chooserUICases,
		});
		assert.deepEqual(full, {
			control: controlCases,
			chooser: [...requiredCases, ...chooserUICases],
		});
		for (const [suite, selection] of [
			["required", required],
			["investigation", investigation],
			["full", full],
		]) {
			assert.deepEqual(f.simulatorManifest(suite, [partition]), {
				suite,
				partitions: [{ ...partition, ...selection }],
			});
			for (const ids of Object.values(selection)) {
				assert.equal(new Set(ids).size, ids.length);
				if (ids.length)
					assert.deepEqual(
						f.simulatorTestArguments(ids, "all"),
						ids.map(
							(id) => `-only-testing:${id.split("/")[0]}/${id.slice(0, -2)}`,
						),
					);
			}
		}
		for (const group of ["control", "chooser"]) {
			assert.deepEqual(
				[...required[group], ...investigation[group]].sort(),
				[...full[group]].sort(),
			);
			assert(!required[group].some((id) => investigation[group].includes(id)));
			requiredCount += required[group].length;
			investigationCount += investigation[group].length;
			fullCount += full[group].length;
		}
	}
	assert.equal(requiredCount, 40);
	assert.equal(investigationCount, 80);
	assert.equal(fullCount, requiredCount + investigationCount);
	assert.equal(fullCount + 28, 148);
	for (const suite of ["required", "investigation", "full"]) {
		const manifest = f.simulatorManifest(suite);
		manifest.partitions[0].chooser.pop();
		manifest.partitions[0].control.push("OtherSuite/test()");
		assert.deepEqual(
			f.simulatorManifest(suite).partitions,
			f.simulatorPartitions.map((partition) => ({
				...partition,
				...f.simulatorPartitionSelection(partition, suite),
			})),
		);
	}
	assert.throws(() => f.simulatorManifest("required", []), /Empty/);
	assert.throws(
		() =>
			f.simulatorManifest("required", [
				f.simulatorPartitions[0],
				f.simulatorPartitions[0],
			]),
		/Duplicate/,
	);
	for (const suite of ["other", "diagnostic"])
		assert.throws(
			() => f.simulatorManifest(suite),
			/Unexpected simulator suite/,
		);
	for (const ids of [[], ["Suite/test()", "Suite/test()"]]) {
		assert.throws(() => f.simulatorTestArguments(ids, "all"));
		assert.throws(() => f.checkSimulatorResults({}, {}, ids));
	}
});

test("checks require provider preparation only for investigation and the local full suite", async (t) => {
	const f = await fixture(t);
	const common = ["package", "cordova-ios7:compile", "cordova-ios8:compile"];
	const fullChecks = new Set();
	const requiredChecks = [...common];
	for (const partition of f.simulatorPartitions) {
		const prefix = `${partition.framework}:${partition.device}`;
		assert.deepEqual(f.simulatorPartitionChecks(partition), [
			...common,
			`${prefix}:bridge`,
			prefix,
		]);
		requiredChecks.push(`${prefix}:bridge`, prefix);
		const providerChecks = [
			`${prefix}:provider-setup`,
			...documentFormats.map(
				(format) => `${prefix}:seed-${format.toLowerCase()}`,
			),
		];
		const expected = [
			...common,
			...providerChecks,
			`${prefix}:native-control`,
			prefix,
		];
		assert.deepEqual(
			f.simulatorPartitionChecks(partition, "investigation"),
			expected,
		);
		assert.deepEqual(f.simulatorPartitionChecks(partition, "full"), [
			...expected.slice(0, -1),
			`${prefix}:bridge`,
			prefix,
		]);
		const options = f.simulatorPartitionOptions([
			partition.framework,
			partition.device,
			"--investigation-only",
		]);
		assert.deepEqual(options, { ...partition, investigation: true });
		assert.deepEqual(f.simulatorPartitionChecks(options), expected);
		for (const check of f.simulatorPartitionChecks(partition, "full"))
			fullChecks.add(check);
		assert.throws(
			() => f.simulatorPartitionChecks(partition, "other"),
			/Unexpected simulator suite/,
		);
	}
	assert.deepEqual(f.requiredChecks["ios-simulator"], requiredChecks);
	assert.deepEqual(f.simulatorSuiteChecks("required"), requiredChecks);
	assert.deepEqual(f.simulatorSuiteChecks("full"), [...fullChecks]);
	assert.deepEqual(
		f.simulatorSuiteChecks("investigation"),
		[...fullChecks].filter((check) => !check.endsWith(":bridge")),
	);
	assert.equal(fullChecks.size, 43);
	assert.equal(
		[...fullChecks].filter(
			(check) => check.endsWith(":provider-setup") || check.includes(":seed-"),
		).length,
		28,
	);
	assert.throws(
		() =>
			f.simulatorPartitionChecks({
				framework: "cordova-ios9",
				device: "iphone",
			}),
		/Unexpected simulator partition/,
	);
});

test("required partitions run native and bridge hosts separately without provider preparation", async (t) => {
	const f = await fixture(t);
	const { verifyIosSimulator } =
		await import("../../scripts/ios-simulator.mjs");
	const root = join(__dirname, "../..");
	const base = mkdtempSync(join(tmpdir(), "chooser-native-partitions-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	// Only the orchestration is exercised: every native command below is a stub.
	Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
	try {
		const scenarios = [
			...f.simulatorPartitions.map((partition, index) => ({
				partition,
				index,
			})),
			...["missing", "failed", "skipped", "duplicate", "timeout"].map(
				(fault, index) => ({
					partition: f.simulatorPartitions[0],
					index: index + 4,
					fault,
				}),
			),
		];
		for (const { index, partition, fault } of scenarios) {
			const output = join(
				base,
				`${partition.framework}-${partition.device}-${index}`,
			);
			const reportDirectory = join(output, "reports");
			mkdirSync(reportDirectory, { recursive: true });
			const report = { toolchain: {}, checks: [] };
			const checked = (check) => report.checks.push(check);
			const commands = [];
			const bundles = new Map();
			const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`;
			const udid = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
			const run = (command, args) => {
				commands.push({ command, args });
				if (command === "xcodegen") return "mock xcodegen";
				if (command === "/usr/bin/xcodebuild") {
					if (args[0] === "-version")
						return `Xcode ${apple.xcode}\nBuild version ${apple.build}`;
					const scheme = args[args.indexOf("-scheme") + 1];
					assert(["ChooserNative", "ChooserBridge"].includes(scheme));
					if (args[0] === "build-for-testing") return "";
					assert.equal(args[0], "test-without-building");
					const cases = scheme === "ChooserNative" ? nativeCases : bridgeCases;
					assert.deepEqual(
						args.filter((arg) => arg.startsWith("-only-testing:")),
						cases.map(
							(id) => `-only-testing:${id.split("/")[0]}/${id.slice(0, -2)}`,
						),
					);
					const bundle = args[args.indexOf("-resultBundlePath") + 1];
					if (scheme === "ChooserBridge" && fault === "missing") return "";
					if (scheme === "ChooserBridge" && fault === "timeout")
						throw new Error("Bridge test timed out");
					mkdirSync(bundle);
					bundles.set(bundle, {
						summary: {
							totalTestCount: cases.length,
							passedTests: cases.length,
							failedTests: 0,
							skippedTests: 0,
						},
						tests: {
							testNodes: cases.map((nodeIdentifier) => ({
								nodeType: "Test Case",
								nodeIdentifier,
								result: "Passed",
							})),
						},
					});
					if (scheme === "ChooserBridge" && fault) {
						const value = bundles.get(bundle);
						if (fault === "failed") {
							value.summary.passedTests = 0;
							value.summary.failedTests = 1;
							value.tests.testNodes[0].result = "Failed";
						}
						if (fault === "skipped") {
							value.summary.passedTests = 0;
							value.summary.skippedTests = 1;
							value.tests.testNodes[0].result = "Skipped";
						}
						if (fault === "duplicate") {
							value.tests.testNodes.push({ ...value.tests.testNodes[0] });
							value.summary.totalTestCount++;
							value.summary.passedTests++;
						}
					}
					return "";
				}
				assert.equal(command, "/usr/bin/xcrun", "Unexpected native tool");
				if (args[0] === "--sdk") return apple.iphoneos;
				if (args[0] === "xcresulttool") {
					const bundle = bundles.get(args[args.indexOf("--path") + 1]);
					assert(bundle, "Unexpected result extraction");
					if (args[1] === "export" && args[2] === "attachments") return "";
					assert(["summary", "tests"].includes(args[3]));
					return JSON.stringify(bundle[args[3]]);
				}
				assert.equal(args[0], "simctl");
				if (args[1] === "list" && args[2] === "runtimes")
					return JSON.stringify({
						runtimes: [{ identifier: runtime, isAvailable: true }],
					});
				if (args[1] === "list" && args[2] === "devicetypes")
					return JSON.stringify({
						devicetypes: ["iPhone 17", "iPad (A16)"].map((name) => ({
							name,
							identifier: `mock-${name}`,
						})),
					});
				if (args[1] === "create") return udid;
				if (args[1] === "spawn") return "mock failure diagnostics";
				assert.equal(args[2], udid);
				if (args[1] === "get_app_container") {
					assert(
						["com.cyph.chooser.simulator", "com.cyph.chooser.bridge"].includes(
							args[3],
						),
					);
					return join(output, "host-data");
				}
				assert(
					["boot", "bootstatus", "shutdown", "delete"].includes(args[1]),
					`Unexpected simulator action: ${args.join(" ")}`,
				);
				return "";
			};
			const invoke = () =>
				verifyIosSimulator({
					root,
					output,
					reportDirectory,
					report,
					run,
					pack: () => {
						checked("package");
						return root;
					},
					app: (name, alias) => {
						assert.equal(name, "ios");
						const generated = join(output, "generated", alias);
						const config = join(
							generated,
							"platforms/ios",
							alias === "cordova-ios7" ? "ChooserFixture" : "App",
						);
						mkdirSync(join(generated, "platforms/ios/www"), {
							recursive: true,
						});
						mkdirSync(config, { recursive: true });
						writeFileSync(join(config, "config.xml"), "<widget/>");
						return generated;
					},
					checked,
					partition,
				});
			if (fault) {
				assert.throws(invoke, /Simulator qualification failed/, fault);
				assert(
					!report.checks.includes(
						`${partition.framework}:${partition.device}:bridge`,
					),
				);
				assert(
					!report.checks.includes(`${partition.framework}:${partition.device}`),
				);
				assert.equal(
					commands.filter(({ args }) => args[0] === "test-without-building")
						.length,
					2,
				);
				continue;
			}
			invoke();
			assert.deepEqual(
				report.simulator,
				f.simulatorManifest("required", [partition]),
			);
			assert.deepEqual(report.checks, f.simulatorPartitionChecks(partition));
			assert.equal(report.toolchain.simulators.length, 1);
			assert.equal(bundles.size, 2);
			assert.deepEqual(
				commands
					.filter(({ args }) => args[0] === "test-without-building")
					.map(({ args }) => args[args.indexOf("-scheme") + 1]),
				["ChooserNative", "ChooserBridge"],
			);
			assert.equal(
				commands.filter(({ args }) => args[0] === "build-for-testing").length,
				4,
			);
			for (const alias of ["cordova-ios7", "cordova-ios8"]) {
				const spec = JSON.parse(
					readFileSync(
						join(output, "simulator-tests", alias, "project.json"),
						"utf8",
					),
				);
				assert.equal(
					spec.targets.ChooserHost.info.properties.ChooserNativeTests,
					true,
				);
				assert.deepEqual(Object.keys(spec.schemes), [
					"ChooserBridge",
					"ChooserNative",
				]);
				assert.deepEqual(spec.schemes.ChooserNative.test.targets, [
					"ChooserPickerTests",
				]);
				assert.deepEqual(spec.schemes.ChooserBridge.test.targets, [
					"ChooserBridgeTests",
				]);
				assert.equal(
					spec.targets.ChooserBridgeHost.info.properties.ChooserNativeTests,
					true,
				);
				assert.equal(
					spec.targets.ChooserBridgeHost.settings.base
						.PRODUCT_BUNDLE_IDENTIFIER,
					"com.cyph.chooser.bridge",
				);
				assert.deepEqual(spec.targets.ChooserBridgeTests.dependencies[0], {
					target: "ChooserBridgeHost",
				});
				assert.deepEqual(
					spec.targets.ChooserBridgeHost.sources,
					spec.targets.ChooserHost.sources,
				);
				assert.notEqual(
					spec.targets.ChooserBridgeHost.info.path,
					spec.targets.ChooserHost.info.path,
				);
				assert.deepEqual(Object.keys(spec.targets).sort(), [
					"ChooserBridgeHost",
					"ChooserBridgeTests",
					"ChooserHost",
					"ChooserPickerTests",
				]);
			}
		}
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test("only native fixture generation opts out of the real Cordova app host", async (t) => {
	const { prepareIosSimulatorFixture } =
		await import("../../scripts/ios-simulator.mjs");
	const root = join(__dirname, "../..");
	const base = mkdtempSync(join(tmpdir(), "chooser-host-isolation-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const app = readFileSync(
		join(root, "tests/ios/simulator/FixtureApp.swift"),
		"utf8",
	);
	assert.match(
		app,
		/let nativeTests = Bundle\.main\.object\(forInfoDictionaryKey: "ChooserNativeTests"\) as\? Bool == true/,
	);
	assert.match(
		app,
		/window\.rootViewController = nativeTests \? UIViewController\(\) : FixtureController\(\)/,
	);
	assert.match(app, /final class FixtureController: CDVViewController/);
	assert.match(app, /startPage = "index\.html"\s*super\.viewDidLoad\(\)/);
	assert.match(app, /userContentController\.add\(messages, name: "fixture"\)/);
	assert.match(app, /evaluateJavaScript\("window\.pick\.apply/);
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const generated = join(base, alias);
		const config = join(
			generated,
			"platforms/ios",
			alias === "cordova-ios7" ? "ChooserFixture" : "App",
		);
		mkdirSync(join(generated, "platforms/ios/www"), { recursive: true });
		mkdirSync(config, { recursive: true });
		writeFileSync(join(config, "config.xml"), "<widget/>");
		for (const [name, options] of [
			["native", { nativeOnly: true }],
			["ui", { uiOnly: true }],
			["full", {}],
			...["rc1", "rc2"].map((comparisonRelease) => [
				comparisonRelease,
				{
					uiOnly: true,
					adapter: join(root, "scripts/ios-comparison-adapter.cjs"),
					comparisonRelease,
				},
			]),
		]) {
			const directory = join(base, `${alias}-${name}`);
			// Generate and inspect the spec; all native commands remain stubs.
			prepareIosSimulatorFixture({
				root,
				generated,
				packed: root,
				directory,
				alias,
				env: {},
				run: () => "",
				...options,
			});
			const spec = JSON.parse(
				readFileSync(join(directory, "project.json"), "utf8"),
			);
			assert.equal(
				spec.targets.ChooserHost.info.properties.ChooserNativeTests,
				name === "native",
				`${alias} ${name} host flag`,
			);
			assert.deepEqual(
				Object.entries(spec.targets)
					.filter(([, target]) =>
						Object.hasOwn(target.info?.properties ?? {}, "ChooserNativeTests"),
					)
					.map(([target]) => target),
				name === "native" || name === "full"
					? ["ChooserHost", "ChooserBridgeHost"]
					: ["ChooserHost"],
			);
			assert.equal(
				readFileSync(join(directory, "fixture/FixtureApp.swift"), "utf8"),
				app,
			);
			if (name === "full") {
				assert.deepEqual(spec.schemes.Chooser.test.targets, [
					"ChooserPickerTests",
					"ChooserUITests",
				]);
			} else {
				const scheme = name === "native" ? "ChooserNative" : "ChooserUI";
				assert.deepEqual(spec.schemes[scheme].test.targets, [
					name === "native" ? "ChooserPickerTests" : "ChooserUITests",
				]);
			}
		}
	}
});

test("native presenter keeps the Cordova ABI without WebView startup or UIKit mocks", () => {
	const source = readFileSync(
		join(__dirname, "../ios/simulator/ChooserPickerTests.swift"),
		"utf8",
	);
	const code = source.replace(/\/\/[^\n]*/g, "");
	const presenter = code
		.split("private final class PickerPresenter: CDVViewController {")[1]
		?.split("\n}\n")[0];
	assert(
		presenter,
		"CDVPlugin.viewController requires the CDVViewController ABI",
	);
	assert.match(code, /plugin\.viewController = presenter/);
	assert.match(presenter, /override func loadView\(\) \{ view = UIView\(\) \}/);
	assert.match(presenter, /override func viewDidLoad\(\) \{\s*\}/);
	assert.doesNotMatch(
		presenter,
		/\bsuper\.(?:loadView|viewDidLoad)\(|\b(?:startPage|webView|webViewEngine|loadSettings|createGapView|createLaunchView|getCommandInstance)\b/,
	);
	assert.doesNotMatch(code, /presenter\.startPage\s*=/);
	assert.match(
		presenter,
		/override var supportedInterfaceOrientations: UIInterfaceOrientationMask \{ \.all \}/,
	);
	assert.match(
		presenter,
		/override func viewDidAppear\(_ animated: Bool\) \{\s*super\.viewDidAppear\(animated\)\s*hasAppeared = true/,
	);
	assert.match(
		presenter,
		/override func viewWillDisappear\(_ animated: Bool\) \{\s*hasAppeared = false\s*super\.viewWillDisappear\(animated\)/,
	);
	assert.match(
		presenter,
		/deferredPresentation = \{ \[self\] in\s*presentUsingUIKit\(presentation, animated: animated, completion: completion\)\s*\}/,
	);
	assert.match(presenter, /\}\s*observe\?\(presentation\)/);
	assert.match(
		presenter,
		/presentation\.started = true\s*super\.present\(presentation\.controller, animated: animated\) \{\s*presentation\.completed = true\s*completion\?\(\)\s*\}/,
	);
	assert.doesNotMatch(presenter, /override func dismiss\(/);
	assert.deepEqual(code.match(/\b(?:super\.present|presenter\.dismiss)\(/g), [
		"super.present(",
		"presenter.dismiss(",
	]);
});

test("qualification rejects full, investigation, missing and altered case manifests", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(part) => {
			delete part.simulator;
		},
		(part) => {
			part.investigation = true;
		},
		(part) => {
			part.investigation = false;
		},
		(part) => {
			part.diagnostic = { scope: "all" };
		},
		(part) => {
			part.diagnostic = false;
		},
		(part) => {
			part.simulator = f.simulatorManifest("investigation", [part.partition]);
		},
		(part) => {
			part.simulator = f.simulatorManifest("full", [part.partition]);
		},
		(part) => {
			part.simulator = {
				...f.simulatorManifest("full", [part.partition]),
				suite: "required",
			};
		},
		(part) => {
			part.simulator = {
				...f.simulatorManifest("investigation", [part.partition]),
				suite: "required",
			};
		},
		(part) => {
			part.simulator.partitions[0].chooser.pop();
		},
		(part) => {
			part.simulator.partitions[0].chooser = nativeCases;
		},
		(part) => {
			part.simulator.partitions[0].control.push("UIKitControlTests/testCSV()");
		},
		(part) => {
			part.simulator.partitions[0].chooser.push(
				part.simulator.partitions[0].chooser[0],
			);
		},
		(part) => {
			part.simulator.partitions[0].device = "ipad";
		},
		(part) => {
			part.simulator.partitions.push(part.simulator.partitions[0]);
		},
	]) {
		const bad = structuredClone(f.parts);
		mutate(bad[0]);
		assert.throws(
			() => f.run([...f.other, ...bad]),
			/manifest|Investigation|Diagnostic/,
		);
	}
	const complete = f.report("ios-simulator", f.requiredChecks["ios-simulator"]);
	for (const suite of ["full", "investigation"]) {
		assert.throws(
			() =>
				f.validateReport(
					{ ...complete, simulator: f.simulatorManifest(suite) },
					sha,
				),
			/manifest/,
		);
	}
});

test("all four isolated partitions qualify together and cannot qualify alone", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.run().lanes.sort(), Object.keys(f.requiredChecks).sort());
	for (const part of f.parts)
		assert.throws(() => f.validateReport(part, sha), /cannot qualify alone/);
	for (let count = 0; count < f.parts.length; count++)
		assert.throws(() => f.run([...f.other, ...f.parts.slice(0, count)]));
	assert.throws(() => f.run([...f.other, ...f.parts, f.parts[0]]));
	assert.throws(
		() =>
			f.run([
				...f.other,
				...f.parts,
				f.report("ios-simulator", f.requiredChecks["ios-simulator"]),
			]),
		/Mixed complete and partial/,
	);
	assert.throws(() => f.run([...f.other, ...f.parts, f.other[0]]));
	const relabeledDiagnostic = structuredClone(f.other);
	relabeledDiagnostic[0].diagnostic = { scope: "all" };
	assert.throws(
		() => f.run([...relabeledDiagnostic, ...f.parts]),
		/Diagnostic evidence/,
	);
	const unrelatedPartition = structuredClone(f.other);
	unrelatedPartition[0].partition = f.parts[0].partition;
	assert.throws(
		() => f.run([...unrelatedPartition, ...f.parts]),
		/cannot qualify alone/,
	);
});

test("each partition requires package, both compiles, native result and bridge result", async (t) => {
	const f = await fixture(t);
	for (const [index, part] of f.parts.entries()) {
		for (const check of part.checks) {
			const bad = structuredClone(f.parts);
			bad[index].checks = part.checks.filter((value) => value !== check);
			assert.throws(
				() => f.run([...f.other, ...bad]),
				/Incomplete simulator partition/,
			);
		}
		const extras = f
			.simulatorPartitionChecks(part.partition, "full")
			.filter((check) => !part.checks.includes(check));
		const foreign = f.parts[(index + 1) % f.parts.length].partition;
		for (const extra of [
			...extras,
			part.checks[0],
			`${foreign.framework}:${foreign.device}`,
		]) {
			const bad = structuredClone(f.parts);
			bad[index].checks.push(extra);
			assert.throws(
				() => f.run([...f.other, ...bad]),
				/Incomplete simulator partition|Duplicate partition checks/,
			);
		}
	}
});

test("partition identities, pins and owned devices must match their actual scope", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(part) => {
			part.partition.device = "other";
		},
		(part) => {
			part.partition.framework = "cordova-ios9";
		},
		(part) => {
			part.partition.scope = "provider";
		},
		(part) => {
			part.diagnostic = { scope: "all" };
		},
		(part) => {
			part.toolchain.apple.iphoneos = "0.0";
		},
		(part) => {
			part.toolchain.simulators[0].alias = "cordova-ios8";
		},
		(part) => {
			part.toolchain.simulators[0].deviceName = "iPad (A16)";
		},
		(part) => {
			part.toolchain.simulators[0].runtime = "other";
		},
		(part) => {
			part.toolchain.simulators[0].udid = "invalid";
		},
		(part) => {
			part.toolchain.simulators.push(part.toolchain.simulators[0]);
		},
	]) {
		const bad = structuredClone(f.parts);
		mutate(bad[0]);
		assert.throws(() => f.run([...f.other, ...bad]));
	}
	const duplicate = structuredClone(f.parts);
	duplicate[3] = structuredClone(duplicate[0]);
	duplicate[3].toolchain.simulators[0].udid =
		f.parts[3].toolchain.simulators[0].udid;
	assert.throws(
		() => f.run([...f.other, ...duplicate]),
		/Missing or duplicate simulator partitions/,
	);
	const reused = structuredClone(f.parts);
	reused[1].toolchain.simulators[0].udid =
		reused[0].toolchain.simulators[0].udid;
	assert.throws(() => f.run([...f.other, ...reused]), /reused a device/);
});

test("partition evidence cannot mix revisions, package identities or failed commands", async (t) => {
	const f = await fixture(t);
	for (const patch of [
		{ commit: "b".repeat(40) },
		{ schema: 2 },
		{ status: "failed" },
		{ commands: [] },
		{ commands: [{ status: 1 }] },
		{ package: { version, integrity: "sha512-ZGVmZw==" } },
		{ package: { version: version + "-other", integrity: "sha512-YWJjZA==" } },
	]) {
		const bad = structuredClone(f.parts);
		Object.assign(bad[0], patch);
		assert.throws(() => f.run([...f.other, ...bad]));
	}
	for (const result of ["failure", "skipped", "cancelled", undefined])
		assert.throws(
			() => f.run(undefined, { ...f.jobs, "ios-simulator": { result } }),
			/did not succeed/,
		);
});
