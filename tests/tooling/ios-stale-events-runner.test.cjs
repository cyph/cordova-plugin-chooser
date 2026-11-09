const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const test = require("node:test");

const repository = join(__dirname, "../..");
const load = () => import("../../scripts/ios-stale-events.mjs");
const loadModel = () => import("../../scripts/ios-stale-events-model.mjs");
const ids = ["baseline", "photos", "adaptive", "request-id"];
const cases = [
	"ChooserPickerTests/testPhotoPickerConfigurationAndCancellation()",
	"ChooserPickerTests/testAdaptiveDismissalAndStaleCallbacks()",
	"ChooserPickerTests/testSignalCancellationIdentityAndImmediateReopen()",
];
const commit = "a".repeat(40);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (bytes, algorithm = "sha256") =>
	createHash(algorithm)
		.update(bytes)
		.digest(algorithm === "sha512" ? "base64" : "hex");
function write(path, bytes) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
}
function files(directory, prefix = "") {
	return Object.fromEntries(
		readdirSync(join(directory, prefix), { withFileTypes: true })
			.filter((entry) => !entry.isSymbolicLink())
			.sort((a, b) => a.name.localeCompare(b.name))
			.flatMap((entry) => {
				const name = prefix ? `${prefix}/${entry.name}` : entry.name;
				return entry.isDirectory()
					? Object.entries(files(directory, name))
					: [[name, readFileSync(join(directory, name)).toString("base64")]];
			}),
	);
}

// Real xcresult tree and summary shapes, including Xcode's opaque numeric ID.
function results(mutations, id, fault) {
	const mutation = mutations.find((value) => value.id === id);
	let selected = mutation ? [mutation.test] : [...cases];
	if (fault === "missing-case") selected.pop();
	const failed =
		fault !== "survived" && (Boolean(mutation) || fault === "failed");
	let message = `ChooserPickerTests.swift:123: XCTAssertEqual failed - ${mutation?.marker ?? "baseline assertion"}`;
	if (fault === "unmarked")
		message = "ChooserPickerTests.swift:123: XCTAssertEqual failed";
	if (fault === "wrong-marker")
		message = `XCTAssertEqual failed - ${mutations[1].marker}`;
	if (fault === "assertion-timeout")
		message += " - asynchronous wait timed out";
	const nodes = selected.map((name, index) => ({
		name: name.split("/")[1],
		nodeIdentifier: name,
		nodeType: "Test Case",
		result: failed && index === 0 ? "Failed" : "Passed",
		...(failed && index === 0
			? { children: [{ nodeType: "Failure Message", name: message }] }
			: {}),
	}));
	const result = failed ? "Failed" : "Passed";
	const tests = {
		testNodes: [
			{
				name: "All tests",
				nodeType: "Test Plan",
				result,
				children: [
					{
						name: "ChooserPickerTests",
						nodeType: "Unit test bundle",
						result,
						children: [
							{
								name: "ChooserPickerTests",
								nodeType: "Test Suite",
								result,
								children: nodes,
							},
						],
					},
				],
			},
		],
	};
	const summary = {
		result,
		totalTestCount: selected.length,
		failedTests: Number(failed),
		passedTests: selected.length - Number(failed),
		skippedTests: 0,
		expectedFailures: 0,
		testFailures: failed
			? [
					{
						targetName: "ChooserPickerTests",
						testName: selected[0].split("/")[1],
						testIdentifier: 1,
						testIdentifierString: selected[0],
						testIdentifierURL: `test://com.apple.xcode/ChooserSimulator/ChooserPickerTests/${selected[0].slice(0, -2)}`,
						failureText: message,
					},
				]
			: [],
	};
	if (fault === "summary-failure")
		summary.testFailures[0].failureText = "Unrelated XCTest failure";
	return {
		summary,
		tests,
		status: fault === "zero-exit" ? 0 : failed ? 65 : 0,
	};
}

async function fixture(t, faults = {}) {
	let clock = Date.now();
	const { verifyStaleEvents } = await load();
	const { staleEventMutations: mutations } = await loadModel();
	const temporary = mkdtempSync(join(tmpdir(), "chooser-stale-runner-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const root = join(temporary, "repo");
	mkdirSync(root);
	for (const name of [
		"package.json",
		"plugin.xml",
		"www",
		"index.d.ts",
		"LICENSE",
		"NOTICE",
		"src",
		"chainman/apple.json",
		"tests/ios/simulator",
	]) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		cpSync(join(repository, name), join(root, name), { recursive: true });
	}
	const sourceFiles = files(root);
	const packageFiles = Object.fromEntries(
		Object.entries(sourceFiles).filter(
			([name]) => !name.startsWith("tests/") && !name.startsWith("chainman/"),
		),
	);
	const pkg = json(join(root, "package.json"));
	const apple = json(join(root, "chainman/apple.json"));
	const npmCli = join(root, "node_modules/npm/bin/npm-cli.js");
	const cordovaCli = join(root, "node_modules/cordova/bin/cordova");
	write(
		join(root, "node_modules/npm/package.json"),
		JSON.stringify({ name: "npm", version: pkg.devDependencies.npm }),
	);
	write(npmCli, "throw new Error('npm must be stubbed');\n");
	write(cordovaCli, "throw new Error('Cordova must be stubbed');\n");
	write(
		join(root, "node_modules/cordova-ios8/package.json"),
		JSON.stringify({ name: "cordova-ios", version: "8.0.0" }),
	);
	const output = join(root, ".verification/stale-event-mutations");
	const archive = join(output, `${pkg.name}-${pkg.version}.tgz`);
	// Archive transport is stubbed; bytes, integrity, extraction and files are real.
	const canonicalBytes = Buffer.from(JSON.stringify(packageFiles));
	const sourceBytes = Buffer.from(JSON.stringify(sourceFiles));
	const runtime = `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`;
	const device = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
	const commands = [],
		created = [],
		stubErrors = [];
	const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
	const response = (stdout = "", status = 0, stderr = "") => ({
		status,
		signal: null,
		stdout,
		stderr,
	});
	function dispatch(command, args, options) {
		if (command === "git") {
			if (args[0] === "status") return response();
			if (args[0] === "rev-parse") return response(commit);
			assert.deepEqual(args, [
				"archive",
				"--format=tar",
				`--output=${join(output, "source.tar")}`,
				commit,
			]);
			write(join(output, "source.tar"), sourceBytes);
			return response();
		}
		if (command === "python3") {
			assert.deepEqual(args.slice(0, 3), ["-m", "tarfile", "--extract"]);
			assert.deepEqual(args.slice(5), ["--filter", "data"]);
			const destination =
				args[3] === archive ? join(args[4], "package") : args[4];
			for (const [name, encoded] of Object.entries(json(args[3])))
				write(join(destination, name), Buffer.from(encoded, "base64"));
			return response();
		}
		if (command === process.execPath && args[0] === npmCli) {
			assert.equal(options.cwd, join(output, "source"));
			assert.deepEqual(args.slice(1), [
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				output,
			]);
			write(archive, canonicalBytes);
			return response(
				JSON.stringify({
					[pkg.name]: {
						name: pkg.name,
						version: pkg.version,
						filename: basename(archive),
						integrity: `sha512-${digest(canonicalBytes, "sha512")}`,
						files: Object.keys(packageFiles).map((path) => ({ path })),
					},
				}),
			);
		}
		if (command === process.execPath && args[0] === cordovaCli) {
			assert.equal(options.env.npm_config_offline, "true");
			assert.equal(options.env.npm_config_ignore_scripts, "true");
			if (args[1] === "create") {
				write(
					join(args[2], "config.xml"),
					'<widget><preference name="deployment-target" value="13.0" /></widget>',
				);
			} else if (args[1] === "platform") {
				assert.equal(
					realpathSync(join(options.cwd, "node_modules/cordova-ios")),
					realpathSync(join(root, "node_modules/cordova-ios8")),
				);
				assert.deepEqual(args.slice(1), [
					"platform",
					"add",
					"ios@8.0.0",
					"--nosave",
				]);
			} else if (args[1] === "plugin") {
				assert.deepEqual(args.slice(1), [
					"plugin",
					"add",
					`${pkg.name}@${pkg.version}`,
					"--nosave",
				]);
				assert.equal(
					realpathSync(join(options.cwd, "node_modules", pkg.name)),
					realpathSync(join(dirname(options.cwd), "package")),
				);
				assert(
					readFileSync(join(options.cwd, "config.xml"), "utf8").includes(
						'value="15.0"',
					),
				);
			} else {
				assert.deepEqual(args.slice(1), ["prepare", "ios"]);
				write(
					join(options.cwd, "platforms/ios/www/cordova.js"),
					"// Cordova fixture\n",
				);
				write(
					join(options.cwd, "platforms/ios/App/config.xml"),
					readFileSync(join(options.cwd, "config.xml")),
				);
			}
			return response();
		}
		if (command === "xcodegen") {
			assert.deepEqual(args, ["generate", "--spec", "project.json"]);
			assert(existsSync(join(options.cwd, "project.json")));
			return response();
		}
		if (command === "/usr/bin/xcodebuild") {
			if (args[0] === "-version")
				return response(`Xcode ${apple.xcode}\nBuild version ${apple.build}`);
			if (args[0] === "build-for-testing") return response();
			assert.equal(args[0], "test-without-building");
			const bundle = valueAfter(args, "-resultBundlePath"),
				id = basename(dirname(bundle));
			if (faults[id] !== "missing-results") mkdirSync(bundle);
			const evidence = results(mutations, id, faults[id]);
			const result = response(
				`XCTest ${mutations.find((m) => m.id === id)?.marker ?? "baseline"}\n`,
				evidence.status,
			);
			if (faults[id] === "timeout")
				return {
					...result,
					status: null,
					error: Object.assign(new Error("spawn xcodebuild ETIMEDOUT"), {
						code: "ETIMEDOUT",
					}),
				};
			return result;
		}
		assert.equal(command, "/usr/bin/xcrun", `Unexpected command: ${command}`);
		if (args[0] === "--sdk") return response(apple.iphoneos);
		if (args[0] === "xcresulttool") {
			const id = basename(dirname(valueAfter(args, "--path")));
			assert.deepEqual(args.slice(0, 3), [
				"xcresulttool",
				"get",
				"test-results",
			]);
			if (faults[id] === "summary-command" && args[3] === "summary")
				return response("", 1, "summary export failed\n");
			assert(["summary", "tests"].includes(args[3]));
			return response(
				JSON.stringify(results(mutations, id, faults[id])[args[3]]),
			);
		}
		assert.equal(args[0], "simctl");
		if (args[1] === "list")
			return response(
				JSON.stringify(
					args[2] === "runtimes"
						? { runtimes: [{ identifier: runtime, isAvailable: true }] }
						: { devicetypes: [{ name: "iPhone 17", identifier: device }] },
				),
			);
		if (args[1] === "create") {
			assert.equal(args[3], device);
			assert.equal(args[4], runtime);
			const id = args[2].slice("Chooser-stale-".length),
				udid = randomUUID();
			created.push({ id, udid });
			return response(udid);
		}
		assert(["boot", "bootstatus", "shutdown", "delete"].includes(args[1]));
		const owner = created.find(({ udid }) => udid === args[2]);
		assert(owner, "Simulator operation must use a created UDID");
		if (faults[owner.id] === "shutdown-timeout" && args[1] === "shutdown") {
			clock += options.timeout + 20_000;
			return response("", 124, "shutdown timed out\n");
		}
		if (faults[owner.id] === `${args[1]}-failure`)
			return response("", 1, `${args[1]} failed\n`);
		return response();
	}
	const spawn = (command, args, options) => {
		const call = { command, args, options };
		commands.push(call);
		try {
			return (call.result = dispatch(command, args, options));
		} catch (error) {
			stubErrors.push(error);
			throw error;
		}
	};
	return {
		root,
		output,
		commands,
		created,
		mutations,
		packageFiles,
		run() {
			const platform = Object.getOwnPropertyDescriptor(process, "platform");
			let returned, error;
			try {
				Object.defineProperty(process, "platform", {
					...platform,
					value: "darwin",
				});
				returned = verifyStaleEvents({ root, spawn, now: () => clock });
			} catch (caught) {
				error = caught;
			} finally {
				Object.defineProperty(process, "platform", platform);
			}
			assert.deepEqual(
				Object.getOwnPropertyDescriptor(process, "platform"),
				platform,
			);
			assert.deepEqual(
				stubErrors,
				[],
				"The command stub must handle every command",
			);
			const report = json(join(output, "mutation-report.json"));
			if (!error) assert.deepEqual(report, returned);
			for (const [name, bytes] of Object.entries(sourceFiles))
				assert.equal(
					readFileSync(join(root, name)).toString("base64"),
					bytes,
					`Tracked source changed: ${name}`,
				);
			assert.deepEqual(files(join(output, "source")), sourceFiles);
			assert.deepEqual(files(join(output, "canonical/package")), packageFiles);
			assert.deepEqual(readFileSync(archive), canonicalBytes);
			assert.deepEqual(readFileSync(join(output, "source.tar")), sourceBytes);
			assert.equal(statSync(archive).mode & 0o222, 0);
			assert(
				!Object.keys(files(output)).some((name) =>
					name.split("/").includes("qualification.json"),
				),
			);
			assert(!existsSync(join(root, ".verification/reports")));
			assert.equal(report.commands.length, commands.length);
			for (const [index, record] of report.commands.entries()) {
				assert.equal(record.status, commands[index].result.status);
				assert.equal(
					readFileSync(join(output, record.log), "utf8"),
					commands[index].result.stdout + commands[index].result.stderr,
				);
				assert(record.timeout > 0 && record.timeout <= 15 * 60_000);
			}
			for (const { id, udid } of created) {
				const operations = commands
					.filter(({ args }) => args[0] === "simctl" && args[2] === udid)
					.map(({ args }) => args[1]);
				assert.deepEqual(
					operations,
					faults[id] === "boot-failure"
						? ["boot", "shutdown", "delete"]
						: ["boot", "bootstatus", "shutdown", "delete"],
				);
			}
			return { report, error };
		},
	};
}

function failedArm(f, outcome, id, message) {
	assert(outcome.error instanceof AggregateError);
	assert.equal(outcome.report.status, "failed");
	assert.deepEqual(
		outcome.report.arms.map((arm) => arm.id),
		ids,
	);
	for (const arm of outcome.report.arms) {
		assert.equal(arm.status, arm.id === id ? "failed" : "passed");
		if (arm.id === id) assert.match(arm.failure, message);
		else {
			assert.equal(
				arm.outcome,
				arm.id === "baseline" ? "passed" : "guard-regression-detected",
			);
			assert(existsSync(join(f.output, arm.id, "summary.json")));
			assert(existsSync(join(f.output, arm.id, "tests.json")));
		}
	}
	assert.equal(f.created.length, 4);
}

test("stale-event runner executes baseline then three isolated mutants with exact cases and fresh simulators", async (t) => {
	const f = await fixture(t),
		{ report, error } = f.run();
	assert.equal(error, undefined);
	assert.equal(report.status, "passed");
	assert.deepEqual(
		f.mutations.map(({ id, test }) => [id, test]),
		ids.slice(1).map((id, i) => [id, cases[i]]),
	);
	assert.deepEqual(
		report.arms.map(({ id, status, outcome }) => [id, status, outcome]),
		ids.map((id) => [
			id,
			"passed",
			id === "baseline" ? "passed" : "guard-regression-detected",
		]),
	);
	assert.deepEqual(
		f.created.map(({ id }) => id),
		ids,
	);
	assert.equal(new Set(f.created.map(({ udid }) => udid)).size, 4);
	const tests = f.commands.filter(
		({ command, args }) =>
			command === "/usr/bin/xcodebuild" && args[0] === "test-without-building",
	);
	assert.equal(tests.length, 4);
	for (const [index, id] of ids.entries()) {
		const arm = report.arms[index],
			command = tests[index];
		const selected = index ? [cases[index - 1]] : cases;
		assert.deepEqual(arm.cases, selected);
		assert.equal(arm.udid, f.created[index].udid);
		assert.deepEqual(
			command.args.filter((arg) => arg.startsWith("-only-testing:")),
			selected.map(
				(name) => `-only-testing:ChooserPickerTests/${name.slice(0, -2)}`,
			),
		);
		assert(!command.args.some((arg) => arg.startsWith("-skip-testing:")));
		for (const [flag, value] of [
			["-scheme", "ChooserNative"],
			["-destination", `platform=iOS Simulator,id=${arm.udid}`],
			["-parallel-testing-enabled", "NO"],
			["-resultBundlePath", join(f.output, id, "tests.xcresult")],
		])
			assert.equal(command.args[command.args.indexOf(flag) + 1], value);
		assert(command.options.timeout <= 5 * 60_000);
		const expected = { ...f.packageFiles };
		if (index) {
			const mutation = f.mutations[index - 1],
				before = Buffer.from(expected["src/ios/Chooser.swift"], "base64");
			const after = Buffer.from(
				before
					.toString("utf8")
					.replace(mutation.original, mutation.replacement),
			);
			expected["src/ios/Chooser.swift"] = after.toString("base64");
			assert.deepEqual(arm.patch, {
				path: "src/ios/Chooser.swift",
				original: mutation.original,
				replacement: mutation.replacement,
				beforeSha256: digest(before),
				afterSha256: digest(after),
			});
		}
		assert.deepEqual(files(join(f.output, id, "package")), expected);
		assert.equal(
			json(join(f.output, id, "fixture/project.json")).targets.ChooserHost.info
				.properties.ChooserNativeTests,
			true,
		);
		assert.deepEqual(
			readFileSync(
				join(f.output, id, "fixture/fixture/ChooserPickerTests.swift"),
			),
			readFileSync(
				join(f.output, "source/tests/ios/simulator/ChooserPickerTests.swift"),
			),
		);
		if (index) {
			const previousDelete = f.commands.findIndex(
				({ args }) =>
					args[0] === "simctl" &&
					args[1] === "delete" &&
					args[2] === report.arms[index - 1].udid,
			);
			const nextCreate = f.commands.findIndex(
				({ args }) =>
					args[0] === "simctl" &&
					args[1] === "create" &&
					args[2] === `Chooser-stale-${id}`,
			);
			assert(previousDelete >= 0 && previousDelete < nextCreate);
		}
	}
	assert.equal(
		f.commands.filter(
			({ args }) => args[0] === join(f.root, "node_modules/npm/bin/npm-cli.js"),
		).length,
		1,
	);
	assert.deepEqual(
		f.commands
			.filter(({ command }) => command === "git")
			.map(({ args }) => args[0]),
		["status", "rev-parse", "archive", "rev-parse", "status"],
	);
});

test("only classified mutant assertion failures are accepted, even when stdout has the expected marker", async (t) => {
	for (const [fault, reason] of [
		["unmarked", /marker|Unrelated failure/i],
		["wrong-marker", /marker|Unrelated failure/i],
		["summary-failure", /marker|Unrelated failure/i],
		["assertion-timeout", /Infrastructure failure/],
		["zero-exit", /command status/],
		["survived", /command status|survived/],
	])
		await t.test(fault, async (t) => {
			const f = await fixture(t, { photos: fault });
			failedArm(f, f.run(), "photos", reason);
			assert(existsSync(join(f.output, "photos/summary.json")));
			assert(existsSync(join(f.output, "photos/tests.json")));
		});
});

test("baseline command, result, or boot failure cleans up and prevents every mutant", async (t) => {
	for (const fault of ["failed", "missing-case", "boot-failure"])
		await t.test(fault, async (t) => {
			const f = await fixture(t, { baseline: fault }),
				{ report, error } = f.run();
			assert(error instanceof AggregateError);
			assert.equal(report.status, "failed");
			assert.deepEqual(
				report.arms.map(({ id, status }) => [id, status]),
				[["baseline", "failed"]],
			);
			assert.match(
				report.arms[0].failure,
				fault === "failed"
					? /command status/
					: fault === "missing-case"
						? /Missing or unexpected simulator case/
						: /Command failed/,
			);
			assert.equal(f.created.length, 1);
			for (const id of ids.slice(1)) assert(!existsSync(join(f.output, id)));
		});
});

test("mutant timeout and missing result bundle fail while preserving independent arms and cleanup", async (t) => {
	for (const [id, fault, reason] of [
		["photos", "timeout", /ETIMEDOUT/],
		["adaptive", "missing-results", /No XCTest result bundle/],
	])
		await t.test(fault, async (t) => {
			const f = await fixture(t, { [id]: fault }),
				outcome = f.run();
			failedArm(f, outcome, id, reason);
			const collection = f.commands.filter(
				({ args }) =>
					args[0] === "xcresulttool" &&
					args.includes(join(f.output, id, "tests.xcresult")),
			);
			assert.deepEqual(
				collection.map(({ args }) => args[3]),
				fault === "timeout" ? ["summary", "tests"] : [],
			);
			if (fault === "timeout") {
				const command = outcome.report.commands.find(({ error }) =>
					error?.includes("ETIMEDOUT"),
				);
				assert.equal(command.status, null);
				assert(existsSync(join(f.output, id, "summary.json")));
				assert(existsSync(join(f.output, id, "tests.json")));
			}
		});
});

test("failed simulator shutdown still deletes its UDID and runs later mutants", async (t) => {
	const f = await fixture(t, { photos: "shutdown-failure" });
	failedArm(f, f.run(), "photos", /Command failed \(1\)/);
	const udid = f.created.find(({ id }) => id === "photos").udid;
	const cleanup = f.commands.filter(
		({ args }) =>
			args[0] === "simctl" &&
			args[2] === udid &&
			["shutdown", "delete"].includes(args[1]),
	);
	assert.deepEqual(
		cleanup.map(({ result }) => result.status),
		[1, 0],
	);
});

test("summary export failure still collects the test tree and retains the other mutation results", async (t) => {
	const f = await fixture(t, { photos: "summary-command" });
	failedArm(f, f.run(), "photos", /Command failed \(1\)/);
	assert(!existsSync(join(f.output, "photos/summary.json")));
	assert(existsSync(join(f.output, "photos/tests.json")));
	assert.deepEqual(
		f.commands
			.filter(
				({ args }) =>
					args[0] === "xcresulttool" &&
					args.includes(join(f.output, "photos/tests.xcresult")),
			)
			.map(({ args }) => args[3]),
		["summary", "tests"],
	);
});

test("shutdown timeout cannot exhaust the independent simulator deletion budget", async (t) => {
	const f = await fixture(t, { photos: "shutdown-timeout" });
	failedArm(f, f.run(), "photos", /Command failed \(124\)/);
	const udid = f.created.find(({ id }) => id === "photos").udid;
	const cleanup = f.commands.filter(
		({ args }) =>
			args[0] === "simctl" &&
			args[2] === udid &&
			["shutdown", "delete"].includes(args[1]),
	);
	assert.deepEqual(
		cleanup.map(({ result }) => result.status),
		[124, 0],
	);
	assert.deepEqual(
		cleanup.map(({ options }) => options.timeout),
		[40_000, 40_000],
	);
});
