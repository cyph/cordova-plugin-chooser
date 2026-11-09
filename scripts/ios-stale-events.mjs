import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appleEnvironment } from "./apple.mjs";
import { stageFrozenPackage } from "./fixture-packages.mjs";
import { comparisonFiles } from "./ios-comparison-packages.mjs";
import {
	prepareIosSimulatorFixture,
	prepareSimulatorApp,
} from "./ios-simulator.mjs";
import { pinnedNpm } from "./npm.mjs";
import { checkPackedFiles, packedPackage } from "./package.mjs";
import { simulatorTestArguments } from "./simulator-results.mjs";
import { spawnVerified } from "./verification-command.mjs";
import { withFinalizers } from "./verification-lifecycle.mjs";
import {
	applyStaleEventMutation,
	checkStaleEventResults,
	staleEventMutations,
} from "./ios-stale-events-model.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) =>
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const integrity = (path) =>
	"sha512-" + createHash("sha512").update(readFileSync(path)).digest("base64");
const settings = [
	"CODE_SIGNING_ALLOWED=YES",
	"CODE_SIGN_IDENTITY=-",
	"CODE_SIGN_STYLE=Manual",
	"DEVELOPMENT_TEAM=",
	"IPHONEOS_DEPLOYMENT_TARGET=15.0",
];

// Mutation evidence is deliberately outside reports/ and has no qualification
// manifest. An expected XCTest failure can never qualify or attest a package.
export function verifyStaleEvents({
	root = repository,
	spawn = spawnVerified,
	now = Date.now,
} = {}) {
	assert.equal(
		process.platform,
		"darwin",
		"Stale-event mutation checks require macOS",
	);
	const output = join(root, ".verification/stale-event-mutations");
	rmSync(output, { recursive: true, force: true });
	mkdirSync(output, { recursive: true });
	const report = {
		schema: 1,
		kind: "ios-stale-event-mutations",
		status: "running",
		commands: [],
		arms: [],
	};
	const persist = () => save(join(output, "mutation-report.json"), report);
	let deadline = now() + 20 * 60_000;
	let environment = {};
	const execute = (
		command,
		args,
		cwd = root,
		capture = false,
		extraEnv = {},
		options = {},
	) => {
		const remaining = deadline - now() - 20_000;
		assert(remaining > 0, "Mutation stage deadline exhausted");
		const timeout = Math.min(remaining, options.timeout ?? 15 * 60_000);
		const log = `command-${String(report.commands.length + 1).padStart(4, "0")}.log`;
		const record = {
			command,
			args,
			cwd,
			log,
			timeout,
			started: new Date().toISOString(),
		};
		report.commands.push(record);
		const result = spawn(command, args, {
			cwd,
			env: { ...process.env, ...environment, ...extraEnv },
			stdio: "pipe",
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout,
		});
		writeFileSync(
			join(output, log),
			`${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
		Object.assign(record, {
			status: result.status,
			signal: result.signal,
			finished: new Date().toISOString(),
			...(result.error ? { error: String(result.error) } : {}),
		});
		persist();
		if (!capture) {
			process.stdout.write(result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
		}
		if (result.error) throw result.error;
		assert.equal(result.signal, null, `Command interrupted; see ${log}`);
		assert(
			options.test ? [0, 65].includes(result.status) : result.status === 0,
			`Command failed (${result.status}); see ${log}`,
		);
		return options.test ? record : result.stdout.trim();
	};
	const simctl = (args) =>
		execute("/usr/bin/xcrun", ["simctl", ...args], root, true);
	const failures = [];
	try {
		assert.equal(
			execute(
				"git",
				["status", "--porcelain", "--untracked-files=no"],
				root,
				true,
			),
			"",
			"Mutation checks require clean tracked source",
		);
		report.commit = execute("git", ["rev-parse", "HEAD"], root, true);
		assert.match(report.commit, /^[a-f0-9]{40}$/);
		const source = join(output, "source");
		mkdirSync(source);
		const snapshot = join(output, "source.tar");
		execute("git", [
			"archive",
			"--format=tar",
			`--output=${snapshot}`,
			report.commit,
		]);
		// Resolve Chainman's Python before Xcode's tools take precedence in PATH.
		const python = execute(
			"python3",
			["-c", "import sys; print(sys.executable)"],
			root,
			true,
		);
		assert(isAbsolute(python), "Python must resolve to an absolute executable");
		execute(python, [
			"-m",
			"tarfile",
			"--extract",
			snapshot,
			source,
			"--filter",
			"data",
		]);
		const apple = json(join(source, "chainman/apple.json"));
		environment = appleEnvironment(apple);
		report.toolchain = {
			apple,
			node: process.versions.node,
			framework: "cordova-ios8",
			device: "iphone",
		};
		assert.equal(
			execute("/usr/bin/xcodebuild", ["-version"], root, true),
			`Xcode ${apple.xcode}\nBuild version ${apple.build}`,
		);
		assert.equal(
			execute(
				"/usr/bin/xcrun",
				["--sdk", "iphonesimulator", "--show-sdk-version"],
				root,
				true,
			),
			apple.iphoneos,
		);
		const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`;
		assert(
			JSON.parse(simctl(["list", "runtimes", "--json"])).runtimes.some(
				(r) => r.identifier === runtime && r.isAvailable,
			),
			"Pinned simulator runtime unavailable",
		);
		const device = JSON.parse(
			simctl(["list", "devicetypes", "--json"]),
		).devicetypes.find((d) => d.name === "iPhone 17");
		assert(device, "Pinned iPhone simulator type unavailable");
		const pkg = json(join(source, "package.json"));
		const npm = pinnedNpm(root);
		const packed = packedPackage(
			execute(
				npm.command,
				[
					...npm.args,
					"pack",
					"--json",
					"--ignore-scripts",
					"--pack-destination",
					output,
				],
				source,
				true,
			),
			pkg.name,
		);
		checkPackedFiles(
			source,
			pkg,
			packed.files.map(({ path }) => path),
		);
		const archive = join(output, packed.filename);
		assert.equal(integrity(archive), packed.integrity);
		chmodSync(archive, 0o444);
		report.package = {
			name: pkg.name,
			version: pkg.version,
			integrity: packed.integrity,
		};
		const unpacked = join(output, "canonical");
		mkdirSync(unpacked);
		execute(python, [
			"-m",
			"tarfile",
			"--extract",
			archive,
			unpacked,
			"--filter",
			"data",
		]);
		const canonical = join(unpacked, "package");
		const canonicalFiles = comparisonFiles(canonical);
		save(join(output, "canonical-files.json"), canonicalFiles);
		const checkCanonical = () => {
			assert.equal(
				integrity(archive),
				report.package.integrity,
				"Canonical archive changed",
			);
			assert.deepEqual(
				comparisonFiles(canonical),
				canonicalFiles,
				"Canonical package changed",
			);
		};
		const cordova = (args, cwd) =>
			execute(
				process.execPath,
				[join(root, "node_modules/cordova/bin/cordova"), ...args],
				cwd,
				false,
				{
					npm_config_ignore_scripts: "true",
					npm_config_offline: "true",
					CORDOVA_TELEMETRY_OFF: "1",
				},
			);
		const baseline = {
			id: "baseline",
			cases: staleEventMutations.map(({ test }) => test),
		};
		for (const definition of [
			baseline,
			...staleEventMutations.map((m) => ({ ...m, cases: [m.test] })),
		]) {
			deadline = now() + 20 * 60_000;
			const directory = join(output, definition.id);
			mkdirSync(directory);
			const arm = {
				id: definition.id,
				status: "running",
				cases: definition.cases,
				started: new Date().toISOString(),
			};
			report.arms.push(arm);
			let udid;
			try {
				withFinalizers(() => {
					const variant = join(directory, "package");
					cpSync(canonical, variant, { recursive: true });
					if (definition.id !== "baseline")
						arm.patch = applyStaleEventMutation(variant, definition.id);
					const files = comparisonFiles(variant);
					const changed = files.filter(
						(file, i) =>
							JSON.stringify(file) !== JSON.stringify(canonicalFiles[i]),
					);
					assert.equal(
						files.length,
						canonicalFiles.length,
						"Mutation changed package inventory",
					);
					assert.deepEqual(
						changed.map(({ name }) => name),
						definition.id === "baseline" ? [] : ["src/ios/Chooser.swift"],
					);
					save(join(directory, "files.json"), files);
					const generated = join(directory, "app");
					cordova(
						[
							"create",
							generated,
							"com.cyph.chooser.staleevents",
							"ChooserFixture",
						],
						root,
					);
					const platform = stageFrozenPackage(
						generated,
						join(root, "node_modules/cordova-ios8"),
					);
					arm.cordovaVersion = platform.version;
					cordova(
						["platform", "add", `ios@${platform.version}`, "--nosave"],
						generated,
					);
					prepareSimulatorApp(generated);
					const plugin = stageFrozenPackage(generated, variant);
					cordova(
						["plugin", "add", `${plugin.name}@${plugin.version}`, "--nosave"],
						generated,
					);
					cordova(["prepare", "ios"], generated);
					const fixture = join(directory, "fixture");
					prepareIosSimulatorFixture({
						root: source,
						generated,
						packed: variant,
						directory: fixture,
						alias: "cordova-ios8",
						run: execute,
						env: environment,
						nativeOnly: true,
						buildSettings: settings,
					});
					const created = simctl([
						"create",
						`Chooser-stale-${definition.id}`,
						device.identifier,
						runtime,
					]);
					assert.match(
						created,
						/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
					);
					udid = created;
					assert(
						!report.arms.some((other) => other !== arm && other.udid === udid),
						"Simulator was reused",
					);
					Object.assign(arm, { udid, runtime });
					persist();
					simctl(["boot", udid]);
					simctl(["bootstatus", udid, "-b"]);
					const bundle = join(directory, "tests.xcresult");
					let testCommand, summary, tests;
					withFinalizers(() => {
						testCommand = execute(
							"/usr/bin/xcodebuild",
							[
								"test-without-building",
								"-project",
								"ChooserSimulator.xcodeproj",
								"-scheme",
								"ChooserNative",
								"-destination",
								`platform=iOS Simulator,id=${udid}`,
								"-destination-timeout",
								"120",
								"-parallel-testing-enabled",
								"NO",
								"-resultBundlePath",
								bundle,
								"-derivedDataPath",
								join(fixture, "derived"),
								...simulatorTestArguments(definition.cases, "all"),
								...settings,
								"AppleLanguages=(en)",
								"AppleLocale=en_US",
							],
							fixture,
							false,
							{},
							{ test: true, timeout: 5 * 60_000 },
						);
					}, [
						() => {
							assert(
								existsSync(bundle),
								"No XCTest result bundle was produced",
							);
							summary = JSON.parse(
								execute(
									"/usr/bin/xcrun",
									[
										"xcresulttool",
										"get",
										"test-results",
										"summary",
										"--path",
										bundle,
									],
									root,
									true,
								),
							);
							save(join(directory, "summary.json"), summary);
						},
						() => {
							assert(
								existsSync(bundle),
								"No XCTest result bundle was produced",
							);
							tests = JSON.parse(
								execute(
									"/usr/bin/xcrun",
									[
										"xcresulttool",
										"get",
										"test-results",
										"tests",
										"--path",
										bundle,
									],
									root,
									true,
								),
							);
							save(join(directory, "tests.json"), tests);
						},
					]);
					checkStaleEventResults({
						id: definition.id,
						summary,
						tests,
						command: testCommand,
					});
					arm.outcome =
						definition.id === "baseline"
							? "passed"
							: "guard-regression-detected";
				}, [
					() => {
						// A shutdown timeout must not consume deletion's cleanup budget.
						const cleanup = (action) => {
							deadline = now() + 60_000;
							simctl([action, udid]);
						};
						if (udid)
							withFinalizers(
								() => cleanup("shutdown"),
								[() => cleanup("delete")],
							);
					},
					checkCanonical,
				]);
				arm.status = "passed";
			} catch (error) {
				arm.status = "failed";
				arm.failure = String(error);
				failures.push(error);
			} finally {
				arm.finished = new Date().toISOString();
				persist();
			}
			if (definition.id === "baseline" && arm.status !== "passed") break;
		}
		if (failures.length)
			throw new AggregateError(failures, "Stale-event mutation checks failed");
		assert.equal(report.arms.length, 4, "Incomplete mutation schedule");
		checkCanonical();
		deadline = now() + 60_000;
		assert.equal(
			execute("git", ["rev-parse", "HEAD"], root, true),
			report.commit,
			"HEAD changed during mutation checks",
		);
		assert.equal(
			execute(
				"git",
				["status", "--porcelain", "--untracked-files=no"],
				root,
				true,
			),
			"",
			"Tracked source changed",
		);
		report.status = "passed";
		return report;
	} catch (error) {
		report.status = "failed";
		report.failure = String(error);
		throw error;
	} finally {
		persist();
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	assert.equal(
		process.argv.length,
		2,
		"Stale-event mutation checks take no arguments",
	);
	verifyStaleEvents();
}
