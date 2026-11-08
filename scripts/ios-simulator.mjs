import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appleEnvironment, prepareBridgingHeader } from "./apple.mjs";
import {
	simulatorSelection,
	simulatorTestArguments,
	simulatorCaseRecords,
	simulatorDocuments,
	simulatorPartitions,
	simulatorPartitionSelection,
	simulatorManifest,
} from "./simulator-results.mjs";
import { runSimulatorSuite } from "./simulator-evidence.mjs";
import { withFinalizers } from "./verification-lifecycle.mjs";
import { nativeSwipePolicy } from "./simulator-policy.mjs";

const interfaceOrientations = [
	"UIInterfaceOrientationPortrait",
	"UIInterfaceOrientationPortraitUpsideDown",
	"UIInterfaceOrientationLandscapeLeft",
	"UIInterfaceOrientationLandscapeRight",
];

const sourceNames = simulatorDocuments.map(({ name }) => name).sort();
function sourceFingerprint(directory, names = sourceNames) {
	return names.map((name) => {
		const path = join(directory, name);
		const attributes = statSync(path, { bigint: true });
		return {
			name,
			inode: String(attributes.ino),
			size: String(attributes.size),
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		};
	});
}

export function prepareSimulatorApp(directory) {
	const path = join(directory, "config.xml");
	let config = readFileSync(path, "utf8");
	let found = false;
	config = config.replace(/<preference\b[^>]*\/>/g, (preference) => {
		if (!/\bname\s*=\s*(["'])deployment-target\1/.test(preference))
			return preference;
		found = true;
		const value = preference.match(/\bvalue\s*=\s*(["'])([^"']*)\1/);
		assert(
			value && /^\d+(?:\.\d+){0,2}$/.test(value[2]),
			"Invalid iOS deployment target",
		);
		if (Number(value[2].split(".")[0]) >= 15) return preference;
		return preference.replace(value[0], 'value="15.0"');
	});
	if (!found) {
		assert(
			config.includes("</widget>"),
			"Missing Cordova widget configuration",
		);
		config = config.replace(
			"</widget>",
			'<preference name="deployment-target" value="15.0" />\n</widget>',
		);
	}
	writeFileSync(path, config);
}

export function simulatorNativeOnly(selected) {
	return (
		selected.control.length === 0 &&
		selected.chooser.length > 0 &&
		selected.chooser.every((id) => /^ChooserPickerTests\/test\w+\(\)$/.test(id))
	);
}

export function prepareIosSimulatorFixture({
	root,
	generated,
	packed,
	assets,
	directory,
	alias,
	run,
	env,
	diagnosticScope = "all",
	deploymentTarget = "15.0",
	buildSettings = [],
	uiOnly = false,
	nativeOnly = false,
	adapter,
	comparisonRelease,
	clean = true,
}) {
	if (clean) rmSync(directory, { recursive: true, force: true });
	else
		assert(
			!existsSync(directory),
			`Fixture directory already exists: ${directory}`,
		);
	mkdirSync(directory, { recursive: true });
	cpSync(join(root, "tests/ios/simulator"), join(directory, "fixture"), {
		recursive: true,
	});
	if (assets)
		cpSync(assets, join(directory, "fixture/Assets"), { recursive: true });
	const bridgingHeader = join(directory, "fixture/Host-Bridging-Header.h");
	writeFileSync(bridgingHeader, "#import <Cordova/Cordova.h>\n");
	if (alias === "cordova-ios7") prepareBridgingHeader(bridgingHeader);
	cpSync(join(generated, "platforms/ios/www"), join(directory, "www"), {
		recursive: true,
	});
	cpSync(
		join(root, "tests/ios/simulator/index.html"),
		join(directory, "www/index.html"),
	);
	writeFileSync(
		join(directory, "www/unit.html"),
		"<!doctype html><html><body></body></html>\n",
	);
	const name = alias === "cordova-ios7" ? "ChooserFixture" : "App";
	cpSync(
		join(generated, "platforms/ios", name, "config.xml"),
		join(directory, "config.xml"),
	);
	if (adapter) {
		cpSync(adapter, join(directory, "www/ios-comparison-adapter.js"));
		const page = join(directory, "www/index.html");
		writeFileSync(
			page,
			readFileSync(page, "utf8").replace(
				'<script src="cordova.js"></script>',
				`<script>window.iosComparisonRelease = ${JSON.stringify(comparisonRelease)};</script><script src="cordova.js"></script><script src="ios-comparison-adapter.js"></script>`,
			),
		);
	}
	const common = { platform: "iOS", deploymentTarget };
	const legacy = alias === "cordova-ios7";
	const cordova = {
		target: `Cordova/${legacy ? "CordovaLib" : "Cordova"}`,
		embed: !legacy,
	};
	const spec = {
		name: "ChooserSimulator",
		options: {
			bundleIdPrefix: "com.cyph.chooser",
			createIntermediateGroups: true,
		},
		settings: {
			base: {
				SWIFT_VERSION: "5.0",
				CODE_SIGNING_ALLOWED: "YES",
				CODE_SIGN_IDENTITY: "-",
				CODE_SIGN_STYLE: "Manual",
				DEVELOPMENT_TEAM: "",
				TARGETED_DEVICE_FAMILY: "1,2",
				// Cordova 7's old umbrella import needs its scoped pragma;
				// standalone explicit PCM generation bypasses that header.
				SWIFT_ENABLE_EXPLICIT_MODULES: legacy ? "NO" : "YES",
				...(legacy
					? {
							HEADER_SEARCH_PATHS: [
								"$(inherited)",
								"$(TARGET_BUILD_DIR)/usr/local/lib/include",
								"$(OBJROOT)/UninstalledProducts/include",
								"$(OBJROOT)/UninstalledProducts/$(PLATFORM_NAME)/include",
								"$(BUILT_PRODUCTS_DIR)/include",
								"$(BUILT_PRODUCTS_DIR)",
							],
							OTHER_LDFLAGS: ["$(inherited)", "-ObjC"],
						}
					: {}),
			},
		},
		projectReferences: {
			Cordova: {
				path: join(
					generated,
					legacy
						? "platforms/ios/CordovaLib/CordovaLib.xcodeproj"
						: "platforms/ios/packages/cordova-ios/CordovaLib/CordovaLib.xcodeproj",
				),
			},
		},
		targets: {
			ChooserVault: {
				...common,
				type: "application",
				sources: [
					"fixture/FixtureVault.swift",
					{ path: "fixture/Assets", type: "folder", buildPhase: "resources" },
				],
				settings: {
					base: {
						PRODUCT_BUNDLE_IDENTIFIER: "com.cyph.chooser.fixtures",
						SWIFT_STRICT_CONCURRENCY: "complete",
						SWIFT_TREAT_WARNINGS_AS_ERRORS: "YES",
					},
				},
				info: {
					path: "Vault-Info.plist",
					properties: {
						CFBundleDisplayName: "Chooser Fixtures",
						ChooserSeedMode: diagnosticScope === "provider" ? "copy" : "export",
						UILaunchScreen: {},
						UIFileSharingEnabled: true,
						LSSupportsOpeningDocumentsInPlace: true,
						UIApplicationSceneManifest: {
							UIApplicationSupportsMultipleScenes: false,
						},
						CFBundleDocumentTypes: [
							{
								CFBundleTypeName: "Fixture documents",
								CFBundleTypeRole: "Editor",
								LSHandlerRank: "Alternate",
								LSItemContentTypes: ["public.data"],
							},
						],
						UISupportedInterfaceOrientations: interfaceOrientations,
					},
				},
			},
			ChooserHost: {
				...common,
				type: "application",
				sources: [
					join(packed, "src/ios"),
					"fixture/FixtureApp.swift",
					"fixture/FixturePresentation.swift",
					{ path: "www", type: "folder", buildPhase: "resources" },
					{ path: "config.xml", buildPhase: "resources" },
				],
				dependencies: [cordova],
				settings: {
					base: {
						PRODUCT_BUNDLE_IDENTIFIER: "com.cyph.chooser.simulator",
						SWIFT_STRICT_CONCURRENCY: "complete",
						SWIFT_TREAT_WARNINGS_AS_ERRORS: "YES",
						ENABLE_TESTABILITY: "YES",
						SWIFT_OBJC_BRIDGING_HEADER: "fixture/Host-Bridging-Header.h",
					},
				},
				info: {
					path: "Info.plist",
					properties: {
						CFBundleDisplayName: "Chooser fixture",
						ChooserNativeTests: nativeOnly,
						UILaunchScreen: {},
						UIApplicationSceneManifest: {
							UIApplicationSupportsMultipleScenes: false,
						},
						LSSupportsOpeningDocumentsInPlace: true,
						UISupportedInterfaceOrientations: interfaceOrientations,
						NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
					},
				},
			},
			UIKitControl: {
				...common,
				type: "application",
				sources: [
					"fixture/UIKitControl.swift",
					"fixture/FixturePresentation.swift",
					{ path: "fixture/Assets", type: "folder", buildPhase: "resources" },
				],
				settings: {
					base: {
						PRODUCT_BUNDLE_IDENTIFIER: "com.cyph.chooser.uikit",
						SWIFT_STRICT_CONCURRENCY: "complete",
						SWIFT_TREAT_WARNINGS_AS_ERRORS: "YES",
					},
				},
				info: {
					path: "UIKit-Info.plist",
					properties: {
						CFBundleDisplayName: "UIKit picker control",
						UILaunchScreen: {},
						UIApplicationSceneManifest: {
							UIApplicationSupportsMultipleScenes: false,
						},
						LSSupportsOpeningDocumentsInPlace: true,
						UISupportedInterfaceOrientations: interfaceOrientations,
					},
				},
			},
			UIKitControlTests: {
				...common,
				type: "bundle.ui-testing",
				sources: ["fixture/PickerUI.swift", "fixture/UIKitControlTests.swift"],
				dependencies: [{ target: "UIKitControl" }],
				settings: { base: { GENERATE_INFOPLIST_FILE: "YES" } },
			},

			ChooserPickerTests: {
				...common,
				type: "bundle.unit-test",
				sources: [
					"fixture/ChooserPickerTests.swift",
					"fixture/FixtureSink.m",
					"fixture/FixtureSink.h",
				],
				dependencies: [
					{ target: "ChooserHost" },
					{ ...cordova, embed: false, link: !legacy },
				],
				settings: {
					base: {
						GENERATE_INFOPLIST_FILE: "YES",
						SWIFT_OBJC_BRIDGING_HEADER: "fixture/Test-Bridging-Header.h",
					},
				},
			},
			ChooserUITests: {
				...common,
				type: "bundle.ui-testing",
				sources: ["fixture/PickerUI.swift", "fixture/ChooserUITests.swift"],
				dependencies: [{ target: "ChooserHost" }],
				settings: { base: { GENERATE_INFOPLIST_FILE: "YES" } },
			},
		},
		schemes: {
			ChooserVault: { build: { targets: { ChooserVault: "all" } } },
			UIKitControl: {
				build: { targets: { UIKitControl: "all" } },
				test: { targets: ["UIKitControlTests"] },
			},
			Chooser: {
				build: { targets: { ChooserHost: "all" } },
				test: {
					targets: ["ChooserPickerTests", "ChooserUITests"],
					gatherCoverageData: true,
				},
			},
		},
	};
	// Dedicated schemes avoid building RC2 native contracts against RC1.
	if (!uiOnly)
		spec.schemes.ChooserNative = {
			build: { targets: { ChooserHost: "all" } },
			test: { targets: ["ChooserPickerTests"] },
		};
	if (uiOnly) {
		delete spec.targets.ChooserPickerTests;
		spec.schemes.ChooserUI = {
			build: { targets: { ChooserHost: "all" } },
			test: { targets: ["ChooserUITests"] },
		};
		delete spec.schemes.Chooser;
	}
	if (nativeOnly) {
		for (const target of [
			"ChooserVault",
			"UIKitControl",
			"UIKitControlTests",
			"ChooserUITests",
		])
			delete spec.targets[target];
		spec.schemes = {
			ChooserNative: {
				build: { targets: { ChooserHost: "all" } },
				test: { targets: ["ChooserPickerTests"] },
			},
		};
	}
	writeFileSync(join(directory, "project.json"), JSON.stringify(spec, null, 2));
	run(
		"xcodegen",
		["generate", "--spec", "project.json"],
		directory,
		false,
		env,
	);
	const schemes = nativeOnly
		? [["ChooserNative", "build-for-testing"]]
		: [
				[uiOnly ? "ChooserUI" : "Chooser", "build-for-testing"],
				["UIKitControl", "build-for-testing"],
			];
	if (!nativeOnly && ["all", "provider"].includes(diagnosticScope))
		schemes.push(["ChooserVault", "build"]);
	for (const [scheme, action] of schemes)
		run(
			"/usr/bin/xcodebuild",
			[
				action,
				"-project",
				"ChooserSimulator.xcodeproj",
				"-scheme",
				scheme,
				"-configuration",
				"Debug",
				"-destination",
				"generic/platform=iOS Simulator",
				"-derivedDataPath",
				join(directory, "derived"),
				`ARCHS=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
				...buildSettings,
			],
			directory,
			false,
			env,
		);
	return { alias, directory };
}

export function verifyIosSimulator({
	root,
	output,
	reportDirectory,
	report,
	run,
	pack,
	app,
	checked,
	diagnostic = false,
	modern = false,
	diagnosticDevice = "iphone",
	diagnosticScope = "all",
	partition,
}) {
	assert(
		!partition || (!diagnostic && !modern && diagnosticScope === "all"),
		"Release partitions require the complete baseline suite",
	);
	const suiteKind = partition?.investigation
		? "investigation"
		: partition
			? "required"
			: "full";
	const partitions = partition
		? [{ framework: partition.framework, device: partition.device }]
		: simulatorPartitions;
	if (partition) report.partition = partitions[0];
	if (!diagnostic) report.simulator = simulatorManifest(suiteKind, partitions);
	if (suiteKind === "investigation") report.investigation = true;
	const diagnosticSelection = simulatorSelection(diagnostic, diagnosticScope);
	if (diagnostic)
		report.diagnostic = {
			device: diagnosticDevice,
			scope: diagnosticScope,
			sourceDocuments: ["all", "provider"].includes(diagnosticScope),
			required: diagnosticSelection,
		};
	const selectionFor = (part) =>
		diagnostic
			? diagnosticSelection
			: simulatorPartitionSelection(part, suiteKind);
	const nativeOnly = partitions.every((part) =>
		simulatorNativeOnly(selectionFor(part)),
	);
	assert.equal(
		process.platform,
		"darwin",
		"Simulator qualification requires macOS",
	);
	const apple = JSON.parse(
		readFileSync(
			join(root, modern ? "chainman/apple-modern.json" : "chainman/apple.json"),
			"utf8",
		),
	);
	const env = appleEnvironment(apple);
	const deploymentTarget = "15.0";
	const buildSettings = [
		"CODE_SIGNING_ALLOWED=YES",
		"CODE_SIGN_IDENTITY=-",
		"CODE_SIGN_STYLE=Manual",
		"DEVELOPMENT_TEAM=",
		`IPHONEOS_DEPLOYMENT_TARGET=${deploymentTarget}`,
	];
	assert.equal(
		run("/usr/bin/xcodebuild", ["-version"], root, true, env),
		`Xcode ${apple.xcode}\nBuild version ${apple.build}`,
	);
	assert.equal(
		run(
			"/usr/bin/xcrun",
			["--sdk", "iphonesimulator", "--show-sdk-version"],
			root,
			true,
			env,
		),
		apple.iphoneos,
	);
	report.toolchain.apple = apple;
	report.toolchain.xcodegen = run("xcodegen", ["--version"], root, true, env);
	const simctl = (args) =>
		run("/usr/bin/xcrun", ["simctl", ...args], root, true, env);
	const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`;
	const runtimes = JSON.parse(simctl(["list", "runtimes", "--json"])).runtimes;
	report.toolchain.availableSimulatorRuntimes = runtimes
		.filter((item) => item.isAvailable)
		.map(({ identifier }) => identifier);
	assert(
		runtimes.some((item) => item.identifier === runtime && item.isAvailable),
		"Pinned iOS simulator runtime is unavailable",
	);
	const devices = JSON.parse(
		simctl(["list", "devicetypes", "--json"]),
	).devicetypes;
	const packed = pack();
	const generator = join(output, "generate-simulator-assets");
	const assets = nativeOnly ? undefined : join(output, "simulator-assets");
	if (!nativeOnly) {
		rmSync(assets, { recursive: true, force: true });
		mkdirSync(assets, { recursive: true });

		run(
			"/usr/bin/xcrun",
			[
				"swiftc",
				"-parse-as-library",
				"-swift-version",
				"5",
				join(root, "tests/ios/simulator/GenerateAssets.swift"),
				"-o",
				generator,
			],
			root,
			false,
			env,
		);
		run(generator, [assets], root, false, env);
	}
	report.toolchain.simulators = [];
	report.toolchain.nativeSwipePolicies = [];
	const failures = [];
	const fixtures = [];
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const aliasSelections = partitions
			.filter((part) => part.framework === alias)
			.map(selectionFor);
		const aliasNativeOnly =
			nativeOnly ||
			(aliasSelections.length > 0 &&
				aliasSelections.every(simulatorNativeOnly));
		const generated = app("ios", alias, packed, env, prepareSimulatorApp);
		const directory = join(output, "simulator-tests", alias);
		prepareIosSimulatorFixture({
			root,
			generated,
			packed,
			assets,
			directory,
			alias,
			run,
			env,
			diagnosticScope,
			deploymentTarget,
			buildSettings,
			nativeOnly: aliasNativeOnly,
		});
		checked(`${alias}:compile`);
		fixtures.push({ alias, directory });
	}
	for (const { alias, directory } of fixtures) {
		if (diagnostic && alias !== "cordova-ios7") continue;
		if (partition && alias !== partition.framework) continue;
		for (const [kind, deviceName] of [
			["iphone", "iPhone 17"],
			["ipad", "iPad (A16)"],
		]) {
			if (diagnostic && kind !== diagnosticDevice) continue;
			if (partition && kind !== partition.device) continue;
			const selected = selectionFor({ framework: alias, device: kind });
			const nativeOnly = simulatorNativeOnly(selected);
			const type = devices.find((device) => device.name === deviceName);
			assert(type, `Missing simulator device type: ${deviceName}`);
			const udid = simctl([
				"create",
				`Chooser-${alias}-${kind}`,
				type.identifier,
				runtime,
			]);
			assert.match(udid, /^[0-9A-F-]{36}$/i);
			report.toolchain.simulators.push({ alias, deviceName, runtime, udid });
			const result = join(reportDirectory, `${alias}-${kind}.xcresult`);
			const controlResult = join(
				reportDirectory,
				`${alias}-${kind}-control.xcresult`,
			);
			try {
				simctl(["boot", udid]);
				simctl(["bootstatus", udid, "-b"]);
				let reference;
				const suite = (bundle, scheme, required, scope = diagnosticScope) =>
					runSimulatorSuite({
						resultsAvailable: () => existsSync(bundle),
						missingResults: () =>
							writeFileSync(
								bundle.replace(/\.xcresult$/, "-not-started.json"),
								JSON.stringify({ status: "not-started", required }, null, 2),
							),
						execute: () =>
							run(
								"/usr/bin/xcodebuild",
								[
									"test-without-building",
									"-project",
									"ChooserSimulator.xcodeproj",
									"-scheme",
									scheme,
									"-destination",
									`platform=iOS Simulator,id=${udid}`,
									"-destination-timeout",
									"120",
									"-parallel-testing-enabled",
									"NO",
									"-resultBundlePath",
									bundle,
									"-derivedDataPath",
									join(directory, "derived"),
									...simulatorTestArguments(required, scope),
									...buildSettings,
									"AppleLanguages=(en)",
									"AppleLocale=en_US",
								],
								directory,
								false,
								{
									...env,
									...(scheme === "Chooser" && reference
										? {
												TEST_RUNNER_CHOOSER_NATIVE_SWIPE_POLICY:
													reference.policy,
											}
										: {}),
								},
							),
						extract: (kind) =>
							JSON.parse(
								run(
									"/usr/bin/xcrun",
									[
										"xcresulttool",
										"get",
										"test-results",
										kind,
										"--path",
										bundle,
									],
									root,
									true,
									env,
								),
							),
						save: (part, value) => {
							writeFileSync(
								bundle.replace(/\.xcresult$/, `-${part}.json`),
								JSON.stringify(value, null, 2),
							);
							const details =
								part === "tests"
									? simulatorCaseRecords(value)
									: Object.fromEntries(
											[
												"totalTestCount",
												"passedTests",
												"failedTests",
												"skippedTests",
											].map((key) => [key, value[key]]),
										);
							process.stderr.write(
								`CHOOSER_SIMULATOR ${alias}/${kind}/${scheme} ${part} ${JSON.stringify(details)}\n`,
							);
							if (part === "tests") {
								const container = simctl([
									"get_app_container",
									udid,
									scheme === "UIKitControl"
										? "com.cyph.chooser.uikit"
										: "com.cyph.chooser.simulator",
									"data",
								]);
								const trace = join(
									container,
									"Library/Caches/chooser-fixture-events.log",
								);
								const target = bundle.replace(/\.xcresult$/, "-events.log");
								if (existsSync(trace)) cpSync(trace, target);
								else
									writeFileSync(target, "Fixture event trace unavailable.\n");
							}
						},
						diagnostics: () =>
							withFinalizers(() => {}, [
								() =>
									writeFileSync(
										bundle.replace(/\.xcresult$/, "-provider.log"),
										simctl([
											"spawn",
											udid,
											"log",
											"show",
											"--last",
											"20m",
											"--style",
											"compact",
											"--info",
											"--debug",
											"--predicate",
											'subsystem CONTAINS[c] "DocumentManager" OR subsystem CONTAINS[c] "FileProvider" OR eventMessage CONTAINS "CHOOSER_FIXTURE"',
										]),
									),
								() => {
									if (!existsSync(bundle)) return;
									const destination = bundle.replace(
										/\.xcresult$/,
										"-attachments",
									);
									mkdirSync(destination, { recursive: true });
									run(
										"/usr/bin/xcrun",
										[
											"xcresulttool",
											"export",
											"attachments",
											"--path",
											bundle,
											"--output-path",
											destination,
										],
										root,
										true,
										env,
									);
								},
							]),
						required,
					});
				let sources;
				let before;
				let fingerprintNames = [...sourceNames];
				const recordIdentities = (phase) => {
					if (!diagnostic || !sources) return;
					const input = simctl([
						"get_app_container",
						udid,
						"com.cyph.chooser.uikit",
						"data",
					]);
					const groups = [
						["source", sources, fingerprintNames],
						[
							"export-input",
							join(input, "tmp/chooser-export"),
							fingerprintNames,
						],
						["generated", assets, sourceNames],
					].map(([role, folder, names]) => {
						const paths = names.map((name) => join(folder, name));
						const snapshot = JSON.parse(
							run(generator, ["--identities", ...paths], root, true, env),
						);
						assert.equal(snapshot.schema, 1);
						assert.deepEqual(
							snapshot.files.map((file) => file.path),
							paths,
							"Incomplete filesystem identity evidence",
						);
						return { role, ...snapshot };
					});
					writeFileSync(
						join(
							reportDirectory,
							[alias, kind, "source-identities", phase].join("-") + ".json",
						),
						JSON.stringify({ phase, groups }, null, 2),
					);
				};
				if (!nativeOnly && ["all", "provider"].includes(diagnosticScope)) {
					const derived = join(directory, "derived");
					simctl([
						"install",
						udid,
						join(
							derived,
							"Build/Products/Debug-iphonesimulator/ChooserVault.app",
						),
					]);
					// Start the local provider through a real picker interaction before
					// the shared source container is populated.
					suite(
						join(reportDirectory, `${alias}-${kind}-provider-setup.xcresult`),
						"UIKitControl",
						["UIKitControlTests/testCancel()"],
						"dismissal",
					);
					checked(`${alias}:${kind}:provider-setup`);
					simctl(["launch", udid, "com.cyph.chooser.fixtures"]);
					const container = simctl([
						"get_app_container",
						udid,
						"com.cyph.chooser.fixtures",
						"data",
					]);
					run(
						"python3",
						[
							"-c",
							"import json,pathlib,sys,time\np=pathlib.Path(sys.argv[1]); end=time.monotonic()+60\nwhile not p.is_file() and time.monotonic()<end: time.sleep(0.1)\nassert p.is_file(), 'Fixture source did not become ready'\nstatus=json.loads(p.read_text()); assert status.get('status')=='ready', status",
							join(container, "Library/Caches/chooser-fixture-ready"),
						],
						root,
						false,
						env,
					);
					sources = join(container, "Documents");
					if (diagnosticScope === "all") {
						for (const { format, name } of simulatorDocuments) {
							suite(
								join(
									reportDirectory,
									`${alias}-${kind}-seed-${format.toLowerCase()}.xcresult`,
								),
								"UIKitControl",
								[`UIKitControlTests/testSeed${format}()`],
								"provider",
							);
							assert.deepEqual(
								readFileSync(join(sources, name)),
								readFileSync(join(assets, name)),
								"System-created source changed fixture bytes",
							);
							checked(`${alias}:${kind}:seed-${format.toLowerCase()}`);
						}
					}
					if (diagnosticScope === "provider") {
						for (const [format, name] of [
							["JSON", "fixture-json.json"],
							["PDF", "fixture-pdf.pdf"],
						]) {
							try {
								suite(
									join(
										reportDirectory,
										`${alias}-${kind}-export-${format.toLowerCase()}.xcresult`,
									),
									"UIKitControl",
									[`UIKitControlTests/testExport${format}()`],
									"provider",
								);
								const exported = `exported-${name}`;
								assert.deepEqual(
									readFileSync(join(sources, exported)),
									readFileSync(join(sources, name)),
									"System export changed fixture bytes",
								);
								fingerprintNames.push(exported);
								checked(`${alias}:${kind}:export-${format.toLowerCase()}`);
							} catch (error) {
								failures.push(
									new Error(`${alias}/${kind} ${format} system export failed`, {
										cause: error,
									}),
								);
							}
						}
					}
					before = sourceFingerprint(sources, fingerprintNames);
					writeFileSync(
						join(reportDirectory, `${alias}-${kind}-sources.json`),
						JSON.stringify({ before }, null, 2),
					);
				}

				withFinalizers(() => {
					recordIdentities("before-control");
					try {
						if (selected.control.length) {
							suite(controlResult, "UIKitControl", selected.control);
							checked(`${alias}:${kind}:native-control`);
						}
					} catch (error) {
						failures.push(
							new Error(`${alias}/${kind} UIKit control failed`, {
								cause: error,
							}),
						);
					} finally {
						recordIdentities("after-control");
					}
					if (
						selected.control.includes("UIKitControlTests/testSwipe()") &&
						existsSync(controlResult.replace(/\.xcresult$/, "-tests.json")) &&
						existsSync(controlResult.replace(/\.xcresult$/, "-events.log"))
					) {
						const command = report.commands.find(
							(item) =>
								item.command === "/usr/bin/xcodebuild" &&
								item.args.includes(controlResult),
						);
						assert(command, "Missing native control command evidence");
						reference = nativeSwipePolicy({
							tests: JSON.parse(
								readFileSync(
									controlResult.replace(/\.xcresult$/, "-tests.json"),
									"utf8",
								),
							),
							output: readFileSync(join(reportDirectory, command.log), "utf8"),
							events: readFileSync(
								controlResult.replace(/\.xcresult$/, "-events.log"),
								"utf8",
							),
						});
						report.toolchain.nativeSwipePolicies.push({
							alias,
							kind,
							...reference,
						});
					}
					if (selected.chooser.length)
						suite(
							result,
							nativeOnly ? "ChooserNative" : "Chooser",
							selected.chooser,
						);
				}, [
					() => recordIdentities("after-suites"),
					() => {
						if (nativeOnly || !["all", "provider"].includes(diagnosticScope))
							return;
						const after = sourceFingerprint(sources, fingerprintNames);
						writeFileSync(
							join(reportDirectory, `${alias}-${kind}-sources.json`),
							JSON.stringify({ before, after }, null, 2),
						);
						assert.deepEqual(
							after,
							before,
							"Picker selection changed the fixture provider's originals",
						);
					},
				]);

				if (selected.chooser.length) checked(`${alias}:${kind}`);
			} catch (error) {
				failures.push(
					new Error(`${alias}/${kind} qualification failed`, { cause: error }),
				);
			} finally {
				// Operate only on the simulator allocated by this invocation.
				for (const action of ["shutdown", "delete"]) {
					try {
						simctl([action, udid]);
					} catch (error) {
						failures.push(
							new Error(`${alias}/${kind} ${action} failed`, { cause: error }),
						);
					}
				}
			}
		}
	}
	if (failures.length)
		throw new AggregateError(failures, "Simulator qualification failed");
}
