import assert from "node:assert/strict";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appleEnvironment } from "./apple.mjs";
import { installCapacitorHost } from "./capacitor-host.mjs";
import { writeCapacitorFixture } from "./capacitor-web-fixture.mjs";
import { withFinalizers } from "./verification-lifecycle.mjs";

export function verifyCapacitorIos({ root, output, run, pack, checked }) {
	assert.equal(process.platform, "darwin");
	const apple = JSON.parse(
		readFileSync(join(root, "chainman/apple.json"), "utf8"),
	);
	const env = appleEnvironment(apple);
	const ios = (args, directory = root) =>
		run("/usr/bin/xcrun", ["simctl", ...args], directory, true, env);
	const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`;
	const types = JSON.parse(ios(["list", "devicetypes", "--json"])).devicetypes;
	const type = types.find((value) => value.identifier.endsWith(".iPhone-17"));
	assert(type, "Missing iPhone 17 simulator device type");
	const device = ios(["create", "Chooser Capacitor", type.identifier, runtime]);
	const packed = pack();
	const pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
		.devDependencies["@capacitor/core"];

	withFinalizers(() => {
		ios(["boot", device]);
		ios(["bootstatus", device, "-b"]);
		for (const version of ["8.0.0", pinned]) {
			for (const manager of ["SPM", "CocoaPods"]) {
				const key = `${version}-${manager.toLowerCase()}`;
				const directory = join(output, "capacitor-ios", key);
				rmSync(directory, { recursive: true, force: true });
				const modules = installCapacitorHost(
					root,
					directory,
					"ios",
					version,
					run,
					env,
				);
				const manifest = join(directory, "package.json");
				const pkg = JSON.parse(readFileSync(manifest, "utf8"));
				pkg.dependencies["cordova-plugin-chooser"] = "file:" + packed;
				writeFileSync(manifest, JSON.stringify(pkg));
				cpSync(packed, join(modules, "cordova-plugin-chooser"), {
					recursive: true,
				});

				const id = "org.example.choosercapacitor";
				writeFileSync(
					join(directory, "capacitor.config.json"),
					JSON.stringify({
						appId: id,
						appName: "Chooser fixture",
						webDir: "www",
					}),
				);
				const web = join(directory, "www");
				mkdirSync(web);
				writeCapacitorFixture(web, packed, join(modules, "@capacitor/core"));
				cpSync(join(web, "capacitor.html"), join(web, "index.html"));
				const cli = join(modules, "@capacitor/cli/bin/capacitor");
				run(
					"node",
					[cli, "add", "ios", "--packagemanager", manager],
					directory,
					false,
					env,
				);
				run("node", [cli, "sync", "ios"], directory, false, env);
				const project = join(directory, "ios/App");
				const storyboard = join(project, "App/Base.lproj/Main.storyboard");
				const original = readFileSync(storyboard, "utf8");
				const controller =
					'customClass="CAPBridgeViewController" customModule="Capacitor"';
				assert(
					original.includes(controller),
					"Could not install the Capacitor fixture controller",
				);
				writeFileSync(
					storyboard,
					original.replace(
						controller,
						'customClass="ChooserFixtureController" customModule="App" customModuleProvider="target"',
					),
				);
				const sceneDelegate = join(project, "App/SceneDelegate.swift");
				if (existsSync(sceneDelegate)) {
					const scene = readFileSync(sceneDelegate, "utf8");
					const rootController =
						"rootViewController = CAPBridgeViewController()";
					assert(
						scene.includes(rootController),
						"Could not install the Capacitor scene fixture controller",
					);
					writeFileSync(
						sceneDelegate,
						scene.replace(
							rootController,
							"rootViewController = ChooserFixtureController()",
						),
					);
				}
				appendFileSync(
					join(project, "App/AppDelegate.swift"),
					readFileSync(
						join(root, "tests/ios/capacitor/ChooserFixtureController.swift"),
					),
				);

				const data = join(directory, "derived");
				const container =
					manager === "SPM"
						? ["-project", "App.xcodeproj"]
						: ["-workspace", "App.xcworkspace"];
				run(
					"/usr/bin/xcodebuild",
					[
						...container,
						"-scheme",
						"App",
						"-configuration",
						"Debug",
						"-destination",
						`id=${device}`,
						"-derivedDataPath",
						data,
						"CODE_SIGNING_ALLOWED=NO",
						"build",
					],
					project,
					false,
					env,
				);
				const app = join(data, "Build/Products/Debug-iphonesimulator/App.app");
				const hasPrivacy = (directory) =>
					readdirSync(directory, { withFileTypes: true }).some(
						(entry) =>
							(entry.name === "PrivacyInfo.xcprivacy" &&
								directory.endsWith("ChooserPrivacy.bundle")) ||
							(entry.isDirectory() && hasPrivacy(join(directory, entry.name))),
					);
				assert(
					hasPrivacy(app),
					"Missing Chooser privacy manifest in built Capacitor app",
				);
				ios(["install", device, app]);
				const storage = ios(["get_app_container", device, id, "data"]);
				const report = join(storage, "tmp/chooser-fixture-result");
				rmSync(report, { force: true });
				withFinalizers(() => {
					ios(["launch", device, id]);
					const end = Date.now() + 60_000;
					while (!existsSync(report) && Date.now() < end)
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
					assert(
						existsSync(report),
						"The Capacitor iOS fixture did not record a result",
					);
					assert.equal(readFileSync(report, "utf8"), "passed");
				}, [() => ios(["uninstall", device, id])]);
				checked(`ios-${key}`);
			}
		}
	}, [() => ios(["delete", device])]);
}
