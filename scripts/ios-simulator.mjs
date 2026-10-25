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
import { checkSimulatorResults } from "./simulator-results.mjs";

const sourceNames = [
	"fixture-csv.csv",
	"fixture-image.png",
	"fixture-json.json",
	"fixture-mov.mov",
	"fixture-mp4.mp4",
	"fixture-pdf.pdf",
];
function sourceFingerprint(directory) {
	return sourceNames.map((name) => {
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

export function verifyIosSimulator({
	root,
	output,
	reportDirectory,
	report,
	run,
	pack,
	app,
	checked,
}) {
	assert.equal(
		process.platform,
		"darwin",
		"Simulator qualification requires macOS",
	);
	const apple = JSON.parse(
		readFileSync(join(root, "chainman/apple.json"), "utf8"),
	);
	const env = appleEnvironment(apple);
	const signing = [
		"CODE_SIGNING_ALLOWED=YES",
		"CODE_SIGN_IDENTITY=-",
		"CODE_SIGN_STYLE=Manual",
		"DEVELOPMENT_TEAM=",
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
	const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-2";
	const runtimes = JSON.parse(simctl(["list", "runtimes", "--json"])).runtimes;
	assert(
		runtimes.some((item) => item.identifier === runtime && item.isAvailable),
		"Pinned iOS simulator runtime is unavailable",
	);
	const devices = JSON.parse(
		simctl(["list", "devicetypes", "--json"]),
	).devicetypes;
	const packed = pack();
	const assets = join(output, "simulator-assets");
	rmSync(assets, { recursive: true, force: true });
	mkdirSync(assets, { recursive: true });
	const generator = join(output, "generate-simulator-assets");
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
	const inspector = join(output, "inspect-simulator-sources");
	run(
		"/usr/bin/xcrun",
		[
			"swiftc",
			"-parse-as-library",
			"-swift-version",
			"5",
			join(root, "tests/ios/simulator/InspectSources.swift"),
			"-o",
			inspector,
		],
		root,
		false,
		env,
	);
	report.toolchain.simulators = [];
	const failures = [];
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const generated = app("ios", alias, packed, env);
		const directory = join(output, "simulator-tests", alias);
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
		cpSync(join(root, "tests/ios/simulator"), join(directory, "fixture"), {
			recursive: true,
		});
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
		const name = alias === "cordova-ios7" ? "ChooserFixture" : "App";
		cpSync(
			join(generated, "platforms/ios", name, "config.xml"),
			join(directory, "config.xml"),
		);
		const common = { platform: "iOS", deploymentTarget: "15.0" };
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
						"platforms/ios/CordovaLib/CordovaLib.xcodeproj",
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
							UISupportedInterfaceOrientations: [
								"UIInterfaceOrientationPortrait",
								"UIInterfaceOrientationLandscapeLeft",
								"UIInterfaceOrientationLandscapeRight",
							],
						},
					},
				},
				ChooserHost: {
					...common,
					type: "application",
					sources: [
						join(packed, "src/ios"),
						"fixture/FixtureApp.swift",
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
							UILaunchScreen: {},
							UIApplicationSceneManifest: {
								UIApplicationSupportsMultipleScenes: false,
							},
							LSSupportsOpeningDocumentsInPlace: true,
							UISupportedInterfaceOrientations: [
								"UIInterfaceOrientationPortrait",
								"UIInterfaceOrientationLandscapeLeft",
								"UIInterfaceOrientationLandscapeRight",
							],
							NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
						},
					},
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
					sources: ["fixture/ChooserUITests.swift"],
					dependencies: [{ target: "ChooserHost" }],
					settings: { base: { GENERATE_INFOPLIST_FILE: "YES" } },
				},
			},
			schemes: {
				ChooserVault: { build: { targets: { ChooserVault: "all" } } },
				Chooser: {
					build: { targets: { ChooserHost: "all" } },
					test: {
						targets: ["ChooserPickerTests", "ChooserUITests"],
						gatherCoverageData: true,
					},
				},
			},
		};
		writeFileSync(
			join(directory, "project.json"),
			JSON.stringify(spec, null, 2),
		);
		run(
			"xcodegen",
			["generate", "--spec", "project.json"],
			directory,
			false,
			env,
		);
		for (const [kind, deviceName] of [
			["iphone", "iPhone 17"],
			["ipad", "iPad (A16)"],
		]) {
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
				try {
					const derived = join(directory, "derived");
					run(
						"/usr/bin/xcodebuild",
						[
							"build",
							"-project",
							"ChooserSimulator.xcodeproj",
							"-scheme",
							"ChooserVault",
							"-configuration",
							"Debug",
							"-destination",
							`platform=iOS Simulator,id=${udid}`,
							"-derivedDataPath",
							derived,
							...signing,
						],
						directory,
						false,
						env,
					);
					simctl([
						"install",
						udid,
						join(
							derived,
							"Build/Products/Debug-iphonesimulator/ChooserVault.app",
						),
					]);
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
							"import pathlib,sys,time\np=pathlib.Path(sys.argv[1]); end=time.monotonic()+60\nwhile not p.is_file() and time.monotonic()<end: time.sleep(0.1)\nassert p.read_text()=='ready', 'Fixture source did not become ready'",
							join(container, "Library/Caches/chooser-fixture-ready"),
						],
						root,
						false,
						env,
					);
					simctl(["terminate", udid, "com.cyph.chooser.fixtures"]);
					const sources = join(container, "Documents");
					writeFileSync(
						join(reportDirectory, `${alias}-${kind}-filesystem.json`),
						run(inspector, [sources], root, true, env),
					);
					const before = sourceFingerprint(sources);
					writeFileSync(
						join(reportDirectory, `${alias}-${kind}-sources.json`),
						JSON.stringify({ before }, null, 2),
					);
					const test = (bundle, selection = []) =>
						run(
							"/usr/bin/xcodebuild",
							[
								"test",
								"-project",
								"ChooserSimulator.xcodeproj",
								"-scheme",
								"Chooser",
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
								...signing,
								...selection,
								"AppleLanguages=(en)",
								"AppleLocale=en_US",
							],
							directory,
							false,
							env,
						);
					try {
						try {
							test(controlResult, [
								"-only-testing:ChooserUITests/ChooserUITests/testNativeUIKitControl",
							]);
							const control = JSON.parse(
								run(
									"/usr/bin/xcrun",
									[
										"xcresulttool",
										"get",
										"test-results",
										"summary",
										"--path",
										controlResult,
									],
									root,
									true,
									env,
								),
							);
							writeFileSync(
								join(reportDirectory, `${alias}-${kind}-control-summary.json`),
								JSON.stringify(control, null, 2),
							);
							assert.equal(control.totalTestCount, 1, "Missing UIKit control");
							assert.equal(control.passedTests, 1, "UIKit control failed");
							assert.equal(control.failedTests, 0);
							assert.equal(control.skippedTests, 0);
							checked(`${alias}:${kind}:native-control`);
						} catch (error) {
							failures.push(
								new Error(`${alias}/${kind} UIKit control failed`, {
									cause: error,
								}),
							);
						}
						test(result);
					} finally {
						const after = sourceFingerprint(sources);
						writeFileSync(
							join(reportDirectory, `${alias}-${kind}-sources.json`),
							JSON.stringify({ before, after }, null, 2),
						);
						assert.deepEqual(
							after,
							before,
							"Picker selection changed the fixture provider's originals",
						);
					}
				} catch (error) {
					try {
						const providerLog = simctl([
							"spawn",
							udid,
							"log",
							"show",
							"--last",
							"10m",
							"--style",
							"compact",
							"--info",
							"--debug",
							"--predicate",
							'subsystem CONTAINS[c] "DocumentManager" OR subsystem CONTAINS[c] "FileProvider"',
						]);
						writeFileSync(
							join(reportDirectory, `${alias}-${kind}-provider.log`),
							providerLog,
						);
					} catch {
						console.error("Could not collect simulator provider logs.");
					}
					const failedResult = existsSync(result) ? result : controlResult;
					if (existsSync(failedResult)) {
						const attachments = join(
							reportDirectory,
							`${alias}-${kind}-attachments`,
						);
						mkdirSync(attachments, { recursive: true });
						try {
							run(
								"/usr/bin/xcrun",
								[
									"xcresulttool",
									"export",
									"attachments",
									"--path",
									failedResult,
									"--output-path",
									attachments,
								],
								root,
								true,
								env,
							);
						} catch {
							console.error(
								"Could not export simulator failure attachments; the xcresult bundle is retained.",
							);
						}
					}
					throw error;
				}
				const summary = JSON.parse(
					run(
						"/usr/bin/xcrun",
						[
							"xcresulttool",
							"get",
							"test-results",
							"summary",
							"--path",
							result,
						],
						root,
						true,
						env,
					),
				);
				writeFileSync(
					join(reportDirectory, `${alias}-${kind}-summary.json`),
					JSON.stringify(summary, null, 2),
				);
				const tests = JSON.parse(
					run(
						"/usr/bin/xcrun",
						["xcresulttool", "get", "test-results", "tests", "--path", result],
						root,
						true,
						env,
					),
				);
				writeFileSync(
					join(reportDirectory, `${alias}-${kind}-tests.json`),
					JSON.stringify(tests, null, 2),
				);
				checkSimulatorResults(summary, tests);
				checked(`${alias}:${kind}`);
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
