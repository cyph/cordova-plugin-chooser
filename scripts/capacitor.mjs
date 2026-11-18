import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { installCapacitorHost } from "./capacitor-host.mjs";
import { writeCapacitorFixture } from "./capacitor-web-fixture.mjs";
import { stageFrozenPackage } from "./fixture-packages.mjs";
import {
	withFinalizers,
	withAsyncFinalizers,
	stopOwnedChild,
} from "./verification-lifecycle.mjs";

const pause = (milliseconds) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function runInstrumentation(execute, results, destination) {
	return withFinalizers(execute, [
		() => {
			if (existsSync(results))
				cpSync(results, destination, { recursive: true });
		},
	]);
}

export function prepareCapacitor({
	root,
	output,
	run,
	pack,
	hostModules,
	hostVersion,
}) {
	const packed = pack();
	const directory = join(
		output,
		hostVersion ? `capacitor-${hostVersion}` : "capacitor",
	);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const dependencies = { "cordova-plugin-chooser": "file:" + packed };
	const names = ["@capacitor/core", "@capacitor/android", "@capacitor/cli"];
	const pins = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	).devDependencies;
	const version = hostVersion ?? pins?.["@capacitor/core"];
	const modules = hostModules ?? join(root, "node_modules");
	assert.match(
		version ?? "",
		/^\d+\.\d+\.\d+$/,
		"Capacitor requires exact project pins",
	);
	for (const name of hostVersion ? [] : names)
		assert.equal(
			pins[name],
			version,
			`${name} must match the @capacitor/core project pin`,
		);
	for (const name of names) {
		const installed = stageFrozenPackage(directory, join(modules, name));
		assert.equal(installed.name, name, `Unexpected frozen package for ${name}`);
		assert.equal(
			installed.version,
			version,
			`Installed ${name} differs from the project pin; run just setup`,
		);
		dependencies[name] = version;
	}
	stageFrozenPackage(directory, packed);
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: "chooser-capacitor-fixture",
			private: true,
			version: "1.0.0",
			dependencies,
		}),
	);
	writeFileSync(
		join(directory, "capacitor.config.json"),
		JSON.stringify({
			appId: "com.cyph.chooser.capacitor",
			appName: "Chooser fixture",
			webDir: "www",
		}),
	);
	mkdirSync(join(directory, "www"));
	writeCapacitorFixture(
		join(directory, "www"),
		packed,
		join(modules, "@capacitor/core"),
	);
	cpSync(
		join(directory, "www/capacitor.html"),
		join(directory, "www/index.html"),
	);
	const cli = join(modules, "@capacitor/cli/bin/capacitor");
	const env = { npm_config_offline: "true", npm_config_ignore_scripts: "true" };
	run("node", [cli, "add", "android"], directory, false, env);
	run("node", [cli, "sync", "android"], directory, false, env);
	// Replace the CLI's demonstration tests with this fixture's owned suites.
	for (const name of ["androidTest", "test"])
		rmSync(join(directory, "android/app/src", name), {
			recursive: true,
			force: true,
		});
	const res = join(directory, "android/app/src/main/res");
	const registration = readFileSync(join(res, "xml/config.xml"));
	rmSync(res, { recursive: true, force: true });
	mkdirSync(join(res, "xml"), { recursive: true });
	writeFileSync(join(res, "xml/config.xml"), registration);
	// Keep discovery and bridge assets from the CLI. The emulator fixture owns
	// its locked Gradle build and instrumentation sources.

	cpSync(join(root, "tests/capacitor"), join(directory, "android"), {
		recursive: true,
		filter: (source) =>
			!/[\\/](?:build|\.gradle)(?:[\\/]|$)/.test(source) &&
			!source.endsWith("local.properties"),
	});
	const assets = join(directory, "android/app/src/main/assets");
	const entries = JSON.parse(
		readFileSync(join(assets, "capacitor.plugins.json"), "utf8"),
	);
	assert(
		entries.some(
			(plugin) => plugin.classpath === "com.cyph.cordova.CapacitorChooser",
		),
		"Missing CLI-generated native plugin registration",
	);
	assert(
		!readFileSync(join(assets, "public/cordova_plugins.js"), "utf8").includes(
			"cordova-plugin-chooser",
		),
		"Chooser was also registered as a Cordova plugin",
	);
	return {
		directory,
		version,
		env: {
			CHOOSER_NODE_MODULES: modules,
			CHOOSER_PLUGIN: packed,
		},
	};
}

export async function verifyCapacitorAndroid(context) {
	const { root, output, reportDirectory, report, run, checked, aapt2Path } =
		context;
	assert.equal(process.platform, "linux");
	assert.equal(
		process.arch,
		"x64",
		"The emulator lane requires Linux x86_64 with KVM",
	);
	accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
	report.toolchain.gradle = run("gradle", ["--version"], root, true);
	assert.match(report.toolchain.gradle, /Gradle 8\./);
	assert.match(report.toolchain.gradle, /(?:JVM|Java).*21[. ]/);
	const packed = pack();
	const pinned = prepareCapacitor({ ...context, pack: () => packed });
	const minimum = "8.0.0";
	const minimumModules = installCapacitorHost(
		root,
		join(output, "capacitor-minimum-host"),
		"android",
		minimum,
		run,
	);
	const minimumApp = prepareCapacitor({
		...context,
		pack: () => packed,
		hostModules: minimumModules,
		hostVersion: minimum,
	});
	report.toolchain.capacitor = [pinned.version, minimum];
	const { env } = pinned;
	const sdk = process.env.CHOOSER_EMULATOR_SDK;
	assert(sdk, "Missing Nix-owned emulator SDK");
	const avdHome = join(output, "capacitor-avd");
	rmSync(avdHome, { recursive: true, force: true });
	mkdirSync(avdHome, { recursive: true });
	let emulator;
	let adb;
	await withAsyncFinalizers(() => {
		const emulatorEnv = {
			...env,
			ANDROID_HOME: sdk,
			ANDROID_SDK_ROOT: sdk,
			ANDROID_AVD_HOME: avdHome,
		};
		const avd = "chooser-api33";
		// avdmanager's custom-device prompt is answered by its default (EOF).
		const versions = readdirSync(join(sdk, "cmdline-tools")).filter((version) =>
			existsSync(join(sdk, "cmdline-tools", version, "bin/avdmanager")),
		);
		assert.equal(
			versions.length,
			1,
			"Expected one pinned Android command-line tools version",
		);
		const avdmanager = join(
			sdk,
			"cmdline-tools",
			versions[0],
			"bin/avdmanager",
		);
		accessSync(avdmanager, constants.R_OK | constants.X_OK);
		run(
			avdmanager,
			[
				"create",
				"avd",
				"--force",
				"--name",
				avd,
				"--package",
				"system-images;android-33;google_apis;x86_64",
				"--device",
				"pixel_6",
			],
			root,
			false,
			emulatorEnv,
		);
		const executable = join(sdk, "emulator/emulator");
		accessSync(executable, constants.R_OK | constants.X_OK);
		report.toolchain.emulator = run(
			executable,
			["-version"],
			root,
			true,
			emulatorEnv,
		);
		const port = 5554 + randomInt(64) * 2;
		const serial = `emulator-${port}`;
		assert(
			!run(
				join(sdk, "platform-tools/adb"),
				["devices"],
				root,
				true,
				emulatorEnv,
			).includes(serial),
			"Selected emulator port is already in use",
		);
		adb = (args, timeout = 30_000) =>
			run(
				join(sdk, "platform-tools/adb"),
				["-s", serial, ...args],
				root,
				true,
				emulatorEnv,
				{ timeout },
			);
		const log = openSync(join(reportDirectory, "emulator.log"), "w");
		emulator = spawn(
			executable,
			[
				"-avd",
				avd,
				"-port",
				String(port),
				"-memory",
				"2048",
				"-cores",
				"2",
				"-no-window",
				"-no-audio",
				"-no-boot-anim",
				"-no-snapshot",
				"-gpu",
				"swiftshader_indirect",
				"-accel",
				"on",
			],
			{
				env: { ...process.env, ...emulatorEnv },
				stdio: ["ignore", log, log],
				detached: true,
			},
		);
		emulator.on("error", () => {});
		closeSync(log);
		assert(emulator.pid, "Emulator failed to start");
		// Wait for the selected serial only; never attach to another emulator.
		adb(["wait-for-device"], 4 * 60 * 1000);
		const end = Date.now() + 4 * 60 * 1000;
		let ready = false;
		while (Date.now() < end) {
			if (adb(["shell", "getprop", "sys.boot_completed"]) === "1") {
				ready = true;
				break;
			}
			pause(1_000);
		}
		assert(ready, "Emulator did not boot");
		assert.equal(adb(["shell", "getprop", "ro.build.version.sdk"]), "33");
		report.toolchain.android = adb([
			"shell",
			"getprop",
			"ro.build.fingerprint",
		]);
		adb(["shell", "input", "keyevent", "82"]);
		for (const fixture of [pinned, minimumApp]) {
			const results = join(
				fixture.directory,
				"android/app/build/outputs/androidTest-results/connected",
			);
			runInstrumentation(
				() =>
					run(
						"gradle",
						[
							"--no-daemon",
							"--dependency-verification",
							"strict",
							`-Pandroid.aapt2FromMavenOverride=${aapt2Path("36.0.0")}`,
							":app:connectedDebugAndroidTest",
						],
						join(fixture.directory, "android"),
						false,
						{ ...env, ...fixture.env, ANDROID_SERIAL: serial },
					),
				results,
				join(reportDirectory, `instrumentation-${fixture.version}`),
			);
			run("python3", [
				join(root, "scripts/android_reports.py"),
				"instrumentation",
				results,
			]);
			checked(fixture === pinned ? "api33-bridge" : "api33-bridge-minimum");
		}
	}, [
		() => {
			if (emulator?.pid)
				writeFileSync(
					join(reportDirectory, "logcat.txt"),
					adb(["logcat", "-d"]),
				);
		},
		() => {
			if (emulator?.pid) adb(["emu", "kill"]);
		},
		() => stopOwnedChild(emulator),
		() => rmSync(avdHome, { recursive: true, force: true }),
	]);
}
