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
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stageFrozenPackage } from "./fixture-packages.mjs";

const pause = (milliseconds) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function prepareCapacitor({ root, output, run, pack }) {
	const packed = pack();
	const directory = join(output, "capacitor");
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const dependencies = { "cordova-plugin-chooser": "file:" + packed };
	for (const name of [
		"@capacitor/core",
		"@capacitor/android",
		"@capacitor/cli",
	]) {
		const { version } = stageFrozenPackage(
			directory,
			join(root, "node_modules", name),
		);
		assert.equal(
			version,
			"8.5.2",
			"Update the coordinated Capacitor fixture pin",
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
	writeFileSync(
		join(directory, "www/index.html"),
		'<!doctype html><html><head><meta charset="utf-8"></head><body><script>document.addEventListener("deviceready",()=>window.fixtureReady=true,false);</script></body></html>',
	);
	const cli = join(root, "node_modules/@capacitor/cli/bin/capacitor");
	const env = { npm_config_offline: "true", npm_config_ignore_scripts: "true" };
	run("node", [cli, "add", "android"], directory, false, env);
	run("node", [cli, "sync", "android"], directory, false, env);
	const registration = readFileSync(
		join(directory, "android/app/src/main/res/xml/config.xml"),
		"utf8",
	);
	rmSync(join(directory, "android/app/src/main/res"), {
		recursive: true,
		force: true,
	});
	mkdirSync(join(directory, "android/app/src/main/res/xml"), {
		recursive: true,
	});
	writeFileSync(
		join(directory, "android/app/src/main/res/xml/config.xml"),
		registration,
	);
	// Keep CLI-generated bridge assets and registration, then apply the frozen
	// fixture's Gradle ownership and instrumentation without editing npm packages.
	cpSync(join(root, "tests/capacitor"), join(directory, "android"), {
		recursive: true,
		filter: (source) =>
			!/[\\/](?:build|\.gradle)(?:[\\/]|$)/.test(source) &&
			!source.endsWith("local.properties"),
	});
	assert(
		existsSync(
			join(directory, "android/app/src/main/assets/public/cordova_plugins.js"),
		),
		"Missing generated Cordova bridge assets",
	);
	assert(
		readFileSync(
			join(directory, "android/app/src/main/res/xml/config.xml"),
			"utf8",
		).includes("com.cyph.cordova.Chooser"),
		"Missing generated plugin registration",
	);
	return {
		directory,
		env: {
			CHOOSER_NODE_MODULES: join(root, "node_modules"),
			CHOOSER_PLUGIN: packed,
		},
	};
}

export function verifyCapacitorAndroid(context) {
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
	report.toolchain.capacitor = "8.5.2";
	const { directory, env } = prepareCapacitor(context);
	const sdk = process.env.CHOOSER_EMULATOR_SDK;
	assert(sdk, "Missing Nix-owned emulator SDK");
	const avdHome = join(output, "capacitor-avd");
	rmSync(avdHome, { recursive: true, force: true });
	mkdirSync(avdHome, { recursive: true });
	const emulatorEnv = {
		...env,
		ANDROID_HOME: sdk,
		ANDROID_SDK_ROOT: sdk,
		ANDROID_AVD_HOME: avdHome,
	};
	const avd = "chooser-api33";
	// avdmanager's custom-device prompt is answered by its default (EOF).
	run(
		join(sdk, "cmdline-tools/latest/bin/avdmanager"),
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
	const adb = (args) =>
		run(
			join(sdk, "platform-tools/adb"),
			["-s", serial, ...args],
			root,
			true,
			emulatorEnv,
		);
	const log = openSync(join(reportDirectory, "emulator.log"), "w");
	const emulator = spawn(
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
	closeSync(log);
	try {
		assert(emulator.pid, "Emulator failed to start");
		// Wait for the selected serial only; never attach to another emulator.
		adb(["wait-for-device"]);
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
		const results = join(
			directory,
			"android/app/build/outputs/androidTest-results/connected",
		);
		try {
			run(
				"gradle",
				[
					"--no-daemon",
					"--dependency-verification",
					"strict",
					`-Pandroid.aapt2FromMavenOverride=${aapt2Path("36.0.0")}`,
					":app:connectedDebugAndroidTest",
				],
				join(directory, "android"),
				false,
				{ ...env, ANDROID_SERIAL: serial },
			);
		} finally {
			if (existsSync(results))
				cpSync(results, join(reportDirectory, "instrumentation"), {
					recursive: true,
				});
		}
		run("python3", [
			join(root, "scripts/android_reports.py"),
			"instrumentation",
			results,
		]);
		checked("api33-bridge");
	} finally {
		if (emulator.pid) {
			try {
				writeFileSync(
					join(reportDirectory, "logcat.txt"),
					adb(["logcat", "-d"]),
				);
			} finally {
				try {
					adb(["emu", "kill"]);
				} finally {
					try {
						process.kill(-emulator.pid, "SIGTERM");
					} catch (error) {
						if (error.code !== "ESRCH") throw error;
					}
				}
			}
		}
		rmSync(avdHome, { recursive: true, force: true });
	}
}
