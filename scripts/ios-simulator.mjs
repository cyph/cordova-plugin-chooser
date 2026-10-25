import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appleEnvironment, prepareBridgingHeader } from "./apple.mjs";
import { checkSimulatorResults } from "./simulator-results.mjs";

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
	report.toolchain.simulators = [];
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const generated = app("ios", alias, packed, env);
		const directory = join(output, "simulator-tests", alias);
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
		cpSync(join(root, "tests/ios/simulator"), join(directory, "fixture"), {
			recursive: true,
		});
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
					CODE_SIGNING_ALLOWED: "NO",
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
							UIFileSharingEnabled: true,
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
			try {
				simctl(["boot", udid]);
				simctl(["bootstatus", udid, "-b"]);
				try {
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
							result,
							"-derivedDataPath",
							join(directory, "derived"),
							"CODE_SIGNING_ALLOWED=NO",
							"AppleLanguages=(en)",
							"AppleLocale=en_US",
						],
						directory,
						false,
						env,
					);
				} catch (error) {
					if (existsSync(result)) {
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
									result,
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
			} finally {
				// Operate only on the simulator allocated by this invocation.
				try {
					simctl(["shutdown", udid]);
				} finally {
					simctl(["delete", udid]);
				}
			}
		}
	}
}
