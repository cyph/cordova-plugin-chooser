const assert = require("node:assert/strict");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const test = require("node:test");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const vm = require("node:vm");
const { metadata } = require("../../scripts/ios-comparison-adapter.cjs");
const load = () => import("../../scripts/ios-comparison.mjs");
const loadModel = () => import("../../scripts/ios-comparison-model.mjs");
const loadPackages = () => import("../../scripts/ios-comparison-packages.mjs");
function temporary(t) {
	const directory = mkdtempSync(join(tmpdir(), "chooser-comparison-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}
function completed(record, index) {
	record.udid = `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
	for (const item of [...record.setup, ...record.cases]) item.status = "passed";
}
async function schedule(options = {}) {
	const m = await load();
	const plan = m.createComparisonPlan({
		framework: "cordova-ios7",
		device: "iphone",
		output: "/tmp/comparison-test",
	});
	const report = await m.runComparisonSchedule({
		plan,
		prepare: () => ({}),
		executeArm: ({ record, arm }) => completed(record, arm.ordinal),
		collectArm: () => {},
		...options,
	});
	return { m, plan, report };
}

const metadataTargets = [
	["cordova-ios8", "Image", "fixture-image.png"],
	["cordova-ios7", "PDF", "fixture-pdf.pdf"],
];
const metadataConfigurations = [
	["metadata-mode", "cordova-ios8"],
	...["metadata-regression", "metadata-restoration"].flatMap((experiment) =>
		metadataTargets.map(([framework]) => [experiment, framework]),
	),
];

function metadataFixture(m, experiment, framework = "cordova-ios8") {
	const plan = m.createComparisonPlan({
		framework,
		device: "ipad",
		output: `/tmp/comparison-${experiment}-${framework}`,
		experiment,
	});
	const baseIntegrity = m.comparisonIntegrity(Buffer.from("unmodified RC2"));
	const context = {
		commit: "a".repeat(40),
		tree: "b".repeat(40),
		sourceIntegrity: m.comparisonIntegrity(Buffer.from("source archive")),
		descriptors: Object.fromEntries(
			Object.entries(plan.packages).map(([release, paths]) => [
				release,
				{
					...paths,
					...(release === "rc1"
						? m.rc1
						: {
								version: "2.0.0-rc.2",
								commit: "a".repeat(40),
								tree: "b".repeat(40),
								integrity: paths.metadataAsCopy
									? m.comparisonIntegrity(Buffer.from("metadata-only import"))
									: baseIntegrity,
								...(paths.metadataAsCopy
									? {
											experiment: {
												kind: "metadata-import",
												baseIntegrity,
												changedFile: "src/ios/Chooser.swift",
												original: "asCopy: false",
												replacement: "asCopy: request.mode == .metadata",
											},
										}
									: {}),
							}),
				},
			]),
		),
	};
	return { plan, context };
}

const pickerInitializers = [
	"ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: false)",
	"ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: request.mode == .metadata)",
];

// Stub command/archive transport without npm, network or Apple tools. Package
// files, integrity checks, exact patches and descriptor preparation stay real.
function descriptorFixture(
	t,
	m,
	sourceAsCopy,
	{ experiment = "metadata-restoration", fault } = {},
) {
	const directory = temporary(t);
	const root = join(directory, "repo"),
		output = join(directory, "report");
	const files = {
		"package.json": JSON.stringify({
			name: "cordova-plugin-chooser",
			version: "2.0.0-rc.2",
			main: "www/chooser.js",
		}),
		"plugin.xml": "<plugin/>\n",
		"www/chooser.js": "module.exports = {};\n",
		"src/ios/Other.swift": "// Unchanged package source.\n",
		"src/ios/Chooser.swift": `import UIKit\nlet documents = ${pickerInitializers[Number(sourceAsCopy)]}\n`,
	};
	if (fault === "unknown-mode")
		files["src/ios/Chooser.swift"] = pickerInitializers[0].replace(
			"asCopy: false",
			"asCopy: true",
		);
	function unpack(bytes, destination) {
		for (const [name, contents] of Object.entries(JSON.parse(bytes))) {
			const path = join(destination, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, contents);
		}
	}
	unpack(JSON.stringify(files), root);
	mkdirSync(output);
	const plan = m.createComparisonPlan({
		framework: "cordova-ios8",
		device: "ipad",
		output,
		experiment,
	});
	// Isolate release RC2 preparation from downloading the pinned RC1 archive.
	// This changes only this test fixture, never the plan factory or arm order.
	if (experiment === "metadata-regression")
		plan.packages = { rc2: plan.packages.rc2 };
	const calls = [];
	const run = (command, args, cwd) => {
		calls.push({ command, args, cwd });
		if (command === "git") {
			if (args[0] === "status") return "";
			if (args[0] === "rev-parse")
				return args[1] === "HEAD" ? "a".repeat(40) : "b".repeat(40);
			assert.equal(args[0], "archive");
			assert.equal(args.at(-1), "a".repeat(40));
			writeFileSync(args[2].slice("--output=".length), JSON.stringify(files));
		} else if (command === "tar") {
			unpack(readFileSync(args[1], "utf8"), args[3]);
		} else if (command === "npm") {
			assert.deepEqual(args.slice(0, 4), [
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
			]);
			const packed = Object.fromEntries(
				m
					.comparisonFiles(cwd)
					.map(({ name }) => [name, readFileSync(join(cwd, name), "utf8")]),
			);
			const patched = cwd.endsWith("experimental-source");
			if (
				(patched && fault === "other-file") ||
				(!patched && fault === "canonical-other")
			)
				packed["plugin.xml"] += "changed";
			if (patched && fault === "extra-file") packed["extra.txt"] = "unexpected";
			if (patched && fault === "missing-file")
				delete packed["src/ios/Other.swift"];
			if (
				(patched && fault === "swift") ||
				(!patched && fault === "canonical-swift")
			)
				packed["src/ios/Chooser.swift"] +=
					"// Unexpected additional Swift change.\n";
			if (fault === "manifest")
				packed["package.json"] = JSON.stringify({
					...JSON.parse(packed["package.json"]),
					name: "substitute",
				});
			if (fault === "source")
				writeFileSync(join(cwd, "plugin.xml"), "changed committed source");
			const bytes = Buffer.from(JSON.stringify(packed));
			const filename = "cordova-plugin-chooser-2.0.0-rc.2.tgz";
			writeFileSync(
				join(args[4], filename),
				fault === "integrity"
					? Buffer.concat([bytes, Buffer.from("tampered")])
					: bytes,
			);
			return JSON.stringify([
				{ filename, integrity: m.comparisonIntegrity(bytes) },
			]);
		} else if (command === "python3") {
			unpack(readFileSync(args[2], "utf8"), join(args[3], "package"));
		} else assert.fail(`Unexpected fixture command ${command}`);
		return "";
	};
	return {
		root,
		output,
		plan,
		calls,
		files,
		prepare: () => m.prepareComparisonDescriptors({ root, plan, run }),
	};
}

test("RC1 integrity pin rejects altered bytes and package name/version are checked", async (t) => {
	const m = await load();
	assert.equal(
		m.rc1.url,
		"https://registry.npmjs.org/cordova-plugin-chooser/-/cordova-plugin-chooser-2.0.0-rc.1.tgz",
	);
	assert.equal(
		m.rc1.integrity,
		"sha512-8NYV/y8xT2rnHvM3XuC/beFFBRhWgLfvjlln+0kai/FH+5pXm/6E497c4L0u7+BSc/h073WnyAw+woq5oDF4wg==",
	);
	assert.throws(
		() => m.comparisonIntegrity(Buffer.from("substitute"), m.rc1.integrity),
		/integrity mismatch/,
	);
	const hash = m.comparisonIntegrity(Buffer.from("bytes"));
	assert.equal(m.comparisonIntegrity(Buffer.from("bytes"), hash), hash);
	assert.throws(() => m.comparisonIntegrity(Buffer.from("byteS"), hash));
	const directory = temporary(t);
	mkdirSync(join(directory, "src/ios"), { recursive: true });
	writeFileSync(join(directory, "plugin.xml"), "");
	writeFileSync(join(directory, "chooser.js"), "");
	for (const [name, version, good] of [
		["cordova-plugin-chooser", "2.0.0-rc.1", true],
		["other", "2.0.0-rc.1", false],
		["cordova-plugin-chooser", "2.0.0-rc.2", false],
	]) {
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({ name, version, main: "chooser.js" }),
		);
		if (good) m.checkComparisonPackage(directory, "rc1");
		else assert.throws(() => m.checkComparisonPackage(directory, "rc1"));
	}
});

test("metadata adapter preserves selection and handles only the release-specific cancellation", async () => {
	class CancellationError extends Error {}
	const file = { name: "fixture-json.json" };
	for (const release of ["rc1", "rc2"]) {
		let received;
		const chooser = {
			CancellationError,
			getFileMetadata: async (arg) => {
				received = arg;
				return file;
			},
		};
		assert.deepEqual(await metadata(chooser, release, "application/json"), {
			outcome: "selected",
			file,
		});
		assert.deepEqual(
			received,
			release === "rc1" ? "application/json" : { accept: "application/json" },
		);
	}
	assert.deepEqual(
		await metadata({ getFileMetadata: async () => undefined }, "rc1", "*/*"),
		{ outcome: "canceled" },
	);
	assert.deepEqual(
		await metadata(
			{
				CancellationError,
				getFileMetadata: async () => {
					throw new CancellationError();
				},
			},
			"rc2",
			"*/*",
		),
		{ outcome: "canceled" },
	);
	for (const release of ["rc1", "rc2"]) {
		for (const error of [
			new Error("provider failed"),
			Object.assign(new Error("lookalike"), { code: "CANCELLED" }),
			"RESULT_CANCELED",
		]) {
			await assert.rejects(
				metadata(
					{
						CancellationError,
						getFileMetadata: async () => {
							throw error;
						},
					},
					release,
					"*/*",
				),
				(e) => e === error,
			);
		}
	}
	await assert.rejects(
		metadata(
			{
				CancellationError,
				getFileMetadata: async () => {
					throw new CancellationError();
				},
			},
			"rc1",
			"*/*",
		),
		CancellationError,
	);
	await assert.rejects(
		metadata(
			{ CancellationError, getFileMetadata: async () => undefined },
			"rc2",
			"*/*",
		),
		/Invalid metadata/,
	);
});

test("focused Image/PDF selections use metadata and require the selected filename", async () => {
	const html = readFileSync(
		join(__dirname, "../ios/simulator/index.html"),
		"utf8",
	);
	const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
	for (const release of ["rc1", "rc2"])
		for (const [accept, name] of [
			["image/*", "fixture-image.png"],
			["application/pdf", "fixture-pdf.pdf"],
		]) {
			const outcomes = [],
				calls = [];
			const window = {
				iosComparisonRelease: release,
				iosComparisonMetadata: metadata,
				webkit: {
					messageHandlers: {
						fixture: { postMessage: (s) => outcomes.push(s) },
					},
				},
			};
			vm.runInNewContext(script, {
				window,
				document: { addEventListener() {} },
				chooser: {
					getFileMetadata: async (arg) => {
						calls.push(JSON.parse(JSON.stringify(arg)));
						return { name };
					},
				},
			});
			await window.pick(accept, "", "metadata");
			assert.deepEqual(outcomes, [`selected:${name}`]);
			assert.deepEqual(calls, [release === "rc1" ? accept : { accept }]);
			window.pick(accept, "", "uri");
			assert.equal(calls.length, 1);
			assert.equal(outcomes[1], "error:Unexpected comparison operation");
		}
});

test("dirty tracked source is rejected before resolving, archiving, packing or downloading", async () => {
	const m = await load();
	const calls = [];
	assert.throws(
		() =>
			m.prepareComparisonDescriptors({
				root: "/repo",
				plan: { output: "/unused" },
				run: (cmd, args) => {
					calls.push([cmd, args]);
					return " M www/chooser.js";
				},
			}),
		/clean tracked source/,
	);
	assert.deepEqual(calls, [
		["git", ["status", "--porcelain", "--untracked-files=no"]],
	]);
});

test("metadata variants preserve the actual canonical archive in either source mode", async (t) => {
	const m = { ...(await load()), ...(await loadPackages()) };
	for (const sourceAsCopy of [false, true])
		for (const experiment of ["metadata-mode", "metadata-restoration"])
			await t.test(
				`${experiment}: canonical ${sourceAsCopy ? "import" : "open"}`,
				(t) => {
					const fixture = descriptorFixture(t, m, sourceAsCopy, { experiment });
					const plan = structuredClone(fixture.plan);
					const context = fixture.prepare();
					const canonical =
						context.descriptors[sourceAsCopy ? "rc2-import" : "rc2-open"];
					const patched =
						context.descriptors[sourceAsCopy ? "rc2-open" : "rc2-import"];
					assert.deepEqual(fixture.plan, plan);
					assert.deepEqual(Object.keys(context.descriptors), [
						"rc2-open",
						"rc2-import",
					]);
					assert.equal(canonical.experiment, undefined);
					assert.equal(canonical.metadataAsCopy, sourceAsCopy);
					assert.equal(patched.metadataAsCopy, !sourceAsCopy);
					assert.deepEqual(patched.experiment, {
						kind: sourceAsCopy ? "metadata-open" : "metadata-import",
						baseIntegrity: canonical.integrity,
						changedFile: "src/ios/Chooser.swift",
						patch: {
							path: "src/ios/Chooser.swift",
							original: pickerInitializers[Number(sourceAsCopy)],
							replacement: pickerInitializers[Number(!sourceAsCopy)],
						},
					});
					assert.notEqual(patched.integrity, canonical.integrity);
					for (const descriptor of [canonical, patched]) {
						assert.equal(
							descriptor.integrity,
							m.comparisonIntegrity(readFileSync(descriptor.tarball)),
						);
						assert.equal(descriptor.commit, context.commit);
						assert.equal(descriptor.tree, context.tree);
						assert.deepEqual(
							JSON.parse(
								readFileSync(join(descriptor.evidence, "descriptor.json")),
							),
							descriptor,
						);
					}
					assert.equal(context.trackedClean, true);
					assert.equal(
						context.sourceIntegrity,
						m.comparisonIntegrity(readFileSync(context.sourceArchive)),
					);
					for (const [name, original] of Object.entries(fixture.files)) {
						assert.equal(
							readFileSync(join(fixture.root, name), "utf8"),
							original,
						);
						assert.equal(
							readFileSync(join(context.source, name), "utf8"),
							original,
						);
						assert.equal(
							readFileSync(join(canonical.package, name), "utf8"),
							original,
						);
						assert.equal(
							readFileSync(join(patched.package, name), "utf8"),
							name === "src/ios/Chooser.swift"
								? original.replace(
										patched.experiment.patch.original,
										patched.experiment.patch.replacement,
									)
								: original,
						);
					}
					assert.deepEqual(m.comparisonPluginAsCopy(context.descriptors), {
						"rc2-open": false,
						"rc2-import": true,
					});
					assert.deepEqual(
						fixture.calls
							.filter(({ command }) => command === "npm")
							.map(({ cwd }) => cwd),
						[context.source, join(patched.directory, "experimental-source")],
					);
				},
			);
});

test("release profiles report the committed RC2 package mode and pinned RC1 import mode", async (t) => {
	const m = { ...(await load()), ...(await loadPackages()) };
	for (const sourceAsCopy of [false, true]) {
		const fixture = descriptorFixture(t, m, sourceAsCopy, {
			experiment: "metadata-regression",
		});
		const context = fixture.prepare();
		assert.equal(context.descriptors.rc2.experiment, undefined);
		assert.equal(context.descriptors.rc2.metadataAsCopy, sourceAsCopy);
		assert.deepEqual(
			m.comparisonPluginAsCopy({ rc1: {}, ...context.descriptors }),
			{
				rc1: true,
				rc2: sourceAsCopy,
			},
		);
		assert.throws(
			() => m.comparisonPluginAsCopy({ unknown: {} }),
			/Unknown comparison release/,
		);
		assert.throws(
			() =>
				m.comparisonPluginAsCopy({
					rc2: { ...context.descriptors.rc2, metadataAsCopy: !sourceAsCopy },
				}),
			/mode mismatch/,
		);
	}
});

test("metadata inference rejects unknown, duplicated and drifted initializers without writing", async (t) => {
	const m = await loadPackages();
	const directory = temporary(t),
		path = join(directory, "src/ios/Chooser.swift");
	mkdirSync(dirname(path), { recursive: true });
	for (const source of [
		"// Missing initializer.\n",
		pickerInitializers[0].replace("asCopy: false", "asCopy: true"),
		pickerInitializers[1].replace(
			"request.mode == .metadata",
			"request.mode != .copy",
		),
		pickerInitializers[0].replace("types.isEmpty ? [.item] : types", "types"),
		pickerInitializers[0].replace("asCopy: false", "asCopy:  false"),
		pickerInitializers[0] + "\n" + pickerInitializers[0],
		pickerInitializers[0] + "\n" + pickerInitializers[1],
		pickerInitializers[0] +
			"\nChooserDocumentPicker(documentTypes: [], in: .open)",
	]) {
		writeFileSync(path, source);
		assert.throws(
			() => m.comparisonMetadataAsCopy(directory),
			/exactly one known/,
		);
		for (const asCopy of [false, true]) {
			assert.throws(
				() => m.applyMetadataModeExperiment(directory, asCopy),
				/exactly one known/,
			);
			assert.equal(readFileSync(path, "utf8"), source);
		}
	}
	writeFileSync(path, pickerInitializers[0]);
	for (const mode of [undefined, null, "import", 1]) {
		assert.throws(
			() => m.applyMetadataModeExperiment(directory, mode),
			/Unknown metadata picker mode/,
		);
		assert.equal(readFileSync(path, "utf8"), pickerInitializers[0]);
	}
	assert.throws(
		() => m.applyMetadataModeExperiment(directory, false),
		/must change/,
	);
	assert.deepEqual(m.applyMetadataImportExperiment(directory), {
		path: "src/ios/Chooser.swift",
		original: pickerInitializers[0],
		replacement: pickerInitializers[1],
	});
	assert.throws(
		() => m.applyMetadataImportExperiment(directory),
		/must change/,
	);
});

test("descriptor preparation rejects drift, other mutations and invalid integrity or identity", async (t) => {
	const m = { ...(await load()), ...(await loadPackages()) };
	for (const sourceAsCopy of [false, true])
		for (const [fault, expected] of [
			["unknown-mode", /exactly one known/],
			["other-file", /changed other package files/],
			["extra-file", /changed other package files/],
			["missing-file", /changed other package files/],
			["swift", /more than its exact picker argument/],
			["canonical-swift", /Canonical package changed picker source/],
			["canonical-other", /Canonical package changed committed source/],
			["integrity", /integrity mismatch/],
			["manifest", /Unexpected comparison package name/],
			["source", /Committed comparison source changed/],
		]) {
			const fixture = descriptorFixture(t, m, sourceAsCopy, {
				fault,
				experiment:
					fault === "source" ? "metadata-regression" : "metadata-restoration",
			});
			assert.throws(fixture.prepare, expected);
			if (fault === "unknown-mode")
				assert(!fixture.calls.some(({ command }) => command === "npm"));
			if (fault === "integrity")
				assert(!fixture.calls.some(({ command }) => command === "python3"));
		}
});

test("command deadlines reject before starting and preserve owned-command output", async (t) => {
	const m = await load(),
		directory = temporary(t),
		commands = [];
	const run = m.comparisonCommandRunner({
		root: directory,
		directory,
		deadline: Date.now() + 60000,
		commands,
	});
	assert.equal(
		run(
			process.execPath,
			["-e", "process.stdout.write('bounded')"],
			directory,
			true,
		),
		"bounded",
	);
	assert.equal(commands[0].status, 0);
	assert.equal(commands[0].partialOutput, false);
	assert(commands[0].timeout <= 40000);
	assert.equal(readFileSync(commands[0].log, "utf8"), "bounded");
	const expired = m.comparisonCommandRunner({
		root: directory,
		directory,
		deadline: 2000,
		commands,
		now: () => 2000,
	});
	assert.throws(() => expired("must-not-run", []), { code: "ETIMEDOUT" });
	assert.equal(commands.length, 1);
});

test("failed and timed-out commands link retained output through serialized errors", async (t) => {
	const m = await load(),
		directory = temporary(t),
		commands = [];
	const run = m.comparisonCommandRunner({
		root: directory,
		directory,
		deadline: Date.now() + 60000,
		commands,
	});
	for (const timedOut of [false, true]) {
		assert.throws(
			() =>
				run(
					process.execPath,
					[
						"-e",
						"process.stdout.write('retained diagnostic');" +
							(timedOut ? "setInterval(()=>{},1000)" : "process.exitCode=7"),
					],
					directory,
					true,
					{},
					{ timeout: 1000 },
				),
			(error) => {
				const command = commands.at(-1);
				assert.equal(command.status, timedOut ? 124 : 7);
				assert.equal(command.partialOutput, timedOut);
				assert.equal(error.log, command.log);
				assert.equal(error.partialOutput, timedOut);
				assert(error.message.includes(command.log));
				assert.equal(
					error.message.includes("partial output retained"),
					timedOut,
				);
				assert.match(readFileSync(error.log, "utf8"), /retained diagnostic/);
				assert.equal(m.comparisonTimedOut(error), timedOut);
				const serialized = JSON.parse(JSON.stringify(m.comparisonError(error)));
				assert.equal(serialized.log, command.log);
				assert.equal(serialized.partialOutput, timedOut);
				if (timedOut) assert.equal(serialized.code, "ETIMEDOUT");
				return true;
			},
		);
	}
});

test("validated XCTest observations survive collection failures without promoting unsuccessful cases", async (t) => {
	const m = await load();
	for (const scenario of [
		{ name: "passing XCTest, failed callback snapshot", eventsFailure: true },
		{
			name: "passing XCTest, timed-out arm diagnostics",
			diagnosticTimeout: true,
		},
		{ name: "failed XCTest", result: "Failed" },
		{ name: "missing XCTest bundle", missing: true },
		{ name: "passing XCTest, failed execution", executionStatus: 65 },
		{ name: "passing XCTest, timed-out execution", executionStatus: 124 },
	]) {
		await t.test(scenario.name, async (t) => {
			const directory = temporary(t),
				output = join(directory, "report"),
				container = join(directory, "container"),
				assets = join(directory, "assets"),
				target = "UIKitControlTests/testCancel()";
			for (const path of [
				assets,
				join(container, "Documents"),
				join(container, "Library/Caches"),
			])
				mkdirSync(path, { recursive: true });
			for (const { name } of m.comparisonDocuments) {
				writeFileSync(join(assets, name), name);
				writeFileSync(join(container, "Documents", name), name);
			}
			writeFileSync(
				join(container, "Library/Caches/chooser-fixture-events.log"),
				"callbacks",
			);
			let current;
			// Stub only the process boundary: exercise the real case, command,
			// collection and schedule reporters without invoking Apple tools.
			const spawn = t.mock.method(
				childProcess,
				"spawnSync",
				(monitor, argv) => {
					assert.equal(monitor, "python3");
					const [, , command, ...args] = argv;
					let stdout = "",
						status = 0;
					if (command === "/usr/bin/xcodebuild") {
						current =
							args
								.find((a) => a.startsWith("-only-testing:"))
								.split("/")
								.slice(-2)
								.join("/") + "()";
						if (!(current === target && scenario.missing))
							mkdirSync(args[args.indexOf("-resultBundlePath") + 1]);
						if (current === target) status = scenario.executionStatus ?? 0;
					} else if (
						command === "/usr/bin/xcrun" &&
						args[0] === "xcresulttool"
					) {
						const result =
							current === target ? (scenario.result ?? "Passed") : "Passed";
						stdout = JSON.stringify(
							args[3] === "summary"
								? {
										totalTestCount: 1,
										passedTests: result === "Passed" ? 1 : 0,
										failedTests: result === "Passed" ? 0 : 1,
										skippedTests: 0,
									}
								: {
										testNodes: [
											{
												nodeType: "Test Case",
												nodeIdentifier: current,
												result,
											},
										],
									},
						);
					} else if (command === "/usr/bin/xcrun" && args[0] === "simctl") {
						if (args[1] === "create")
							stdout = "00000000-0000-0000-0000-000000000001";
						if (args[1] === "get_app_container") {
							stdout = container;
							if (
								current === target &&
								args[3] === "com.cyph.chooser.uikit" &&
								scenario.eventsFailure
							)
								status = 124;
						}
						if (args[1] === "spawn" && scenario.diagnosticTimeout) {
							stdout = "partial provider diagnostic";
							status = 124;
						}
					} else {
						assert.equal(command, process.execPath); // Provider readiness poll.
					}
					return { status, signal: null, stdout, stderr: "" };
				},
			);
			syncBuiltinESMExports();
			t.after(() => {
				spawn.mock.restore();
				syncBuiltinESMExports();
			});
			await assert.rejects(
				m.verifyIosComparison({
					output,
					framework: "cordova-ios8",
					device: "iphone",
					prepare: () => ({
						env: {},
						assets,
						profile: { deviceType: "fake", runtime: "fake" },
						descriptors: { rc2: { build: directory } },
					}),
					executeArm: (args) =>
						args.arm.ordinal === 1
							? m.executeIosComparisonArm({ root: directory, ...args })
							: completed(args.record, args.arm.ordinal),
					collectArm: (args) => {
						if (args.arm.ordinal === 1)
							m.collectIosComparisonArm({ root: directory, ...args });
					},
				}),
				/iOS comparison failed/,
			);
			const report = JSON.parse(readFileSync(join(output, "comparison.json"))),
				arm = report.arms[0],
				item = arm.setup[0];
			assert.equal(report.status, "failed");
			assert.equal(
				item.xctestStatus,
				scenario.result || scenario.missing ? "not-validated" : "passed",
			);
			assert.equal(
				item.status,
				scenario.diagnosticTimeout
					? "passed"
					: scenario.executionStatus === 124
						? "timed-out"
						: "failed",
			);
			assert.equal(
				arm.status,
				scenario.diagnosticTimeout ? "passed" : "failed",
			);
			assert.equal(
				arm.evidence.status,
				scenario.diagnosticTimeout ? "failed" : "passed",
			);
			assert(
				[...arm.setup.slice(1), ...arm.cases].every(
					(other) => other.status === "passed",
				),
			);
			assert.equal(report.arms[5].status, "passed");
			if (scenario.result)
				assert.match(item.resultError.message, /Unsuccessful case/);
			if (scenario.missing)
				assert.equal(item.error.message, "Missing xcresult");
			if (scenario.eventsFailure) {
				assert.equal(item.error, undefined);
				assert.equal(item.resultError, undefined);
				assert.equal(item.eventsError.code, "ETIMEDOUT");
				assert.equal(item.eventsError.partialOutput, true);
				assert.equal(readFileSync(item.eventsError.log, "utf8"), container);
			}
			if (scenario.diagnosticTimeout) {
				const [error] = arm.evidence.error.errors;
				assert.equal(error.code, "ETIMEDOUT");
				assert.equal(error.partialOutput, true);
				assert.equal(
					readFileSync(error.log, "utf8"),
					"partial provider diagnostic",
				);
				assert.deepEqual(
					JSON.parse(
						readFileSync(join(output, "arms/01-uikit/01-uikit-evidence.json")),
					).errors,
					[error],
				);
			}
		});
	}
});

test("four partitions isolate descriptors, apps, builds, evidence, and the exact six-arm matrix", async () => {
	const m = await load();
	assert.equal(m.comparisonPartitions.length, 4);
	const paths = [];
	for (const partition of m.comparisonPartitions) {
		const plan = m.createComparisonPlan({
			...partition,
			output: `/tmp/${partition.framework}-${partition.device}`,
		});
		assert.deepEqual(
			plan.arms.map((a) => a.release),
			["uikit", "rc1", "rc2", "rc2", "rc1", "uikit"],
		);
		for (const p of Object.values(plan.packages))
			paths.push(p.generated, p.build, p.evidence);
		for (const arm of plan.arms) {
			paths.push(arm.directory);
			assert.equal(arm.setup.length, 7);
			assert.equal(arm.cases.length, arm.release === "uikit" ? 6 : 7);
			assert(!arm.cases.some((id) => /Swipe|Scoped|Uri|PickerTests/.test(id)));
			if (arm.release === "uikit")
				assert(
					arm.cases.every((id) =>
						/test(Import|Open)Original(JSON|CSV|PDF)/.test(id),
					),
				);
			else
				assert(arm.cases.includes("ChooserUITests/testCancelPromiseReopen()"));
		}
	}
	assert.equal(new Set(paths).size, paths.length);
	assert.throws(() =>
		m.createComparisonPlan({
			framework: "cordova-ios9",
			device: "iphone",
			output: "/tmp/x",
		}),
	);
});

test("release experiment aliases preserve the original serialized plan and runner defaults", async (t) => {
	const m = await load();
	const options = {
		framework: "cordova-ios8",
		device: "ipad",
		output: "/tmp/comparison-default",
	};
	const original = m.createComparisonPlan(options);
	assert.deepEqual(Object.keys(original), [
		"schema",
		"framework",
		"device",
		"output",
		"budgets",
		"packages",
		"arms",
	]);
	assert.equal(
		JSON.stringify(
			m.createComparisonPlan({ ...options, experiment: "releases" }),
		),
		JSON.stringify(original),
	);
	for (const experiment of [null, "", "metadata", "other"])
		assert.throws(
			() => m.createComparisonPlan({ ...options, experiment }),
			/Unexpected comparison experiment/,
		);
	for (const experiment of [undefined, "releases"]) {
		const output = join(temporary(t), "report");
		const report = await m.verifyIosComparison({
			...options,
			output,
			...(experiment === undefined ? {} : { experiment }),
			prepare: () => ({}),
			executeArm: ({ record, arm }) => completed(record, arm.ordinal),
			collectArm: () => {},
		});
		assert.equal(report.status, "passed");
		assert.deepEqual(
			report.plan,
			m.createComparisonPlan({ ...options, output }),
		);
		assert.deepEqual(
			JSON.parse(readFileSync(join(output, "comparison.json"))).plan,
			report.plan,
		);
	}
});

test("targeted metadata experiments permit only iPad PNG on iOS8 and PDF on iOS7", async () => {
	const m = await loadModel();
	const paths = [];
	for (const [experiment, framework] of metadataConfigurations.filter(
		([experiment]) => experiment !== "metadata-mode",
	)) {
		const [, format, name] = metadataTargets.find(([f]) => f === framework);
		const { plan } = metadataFixture(m, experiment, framework);
		const releases =
			experiment === "metadata-restoration"
				? ["uikit", "rc2-open", "rc2-import", "rc2-import", "rc2-open", "uikit"]
				: ["uikit", "rc1", "rc2", "rc2", "rc1", "uikit"];
		assert.equal(plan.experiment, experiment);
		assert.deepEqual(plan.documents, [{ format, name }]);
		assert.deepEqual(plan.budgets, m.comparisonBudgets);
		assert.deepEqual(
			plan.packages,
			m.createComparisonPlan({
				framework,
				device: "ipad",
				output: plan.output,
				experiment:
					experiment === "metadata-restoration" ? "metadata-mode" : "releases",
			}).packages,
		);
		assert.deepEqual(
			plan.arms.map((a) => a.release),
			releases,
		);
		assert.deepEqual(
			plan.arms.map((a) => a.id),
			releases.map((r, i) => `0${i + 1}-${r}`),
		);
		for (const descriptor of Object.values(plan.packages))
			for (const field of ["directory", "generated", "build", "evidence"])
				paths.push(descriptor[field]);
		for (const [index, arm] of plan.arms.entries()) {
			const controls = ["Import", "Open"].map(
				(mode) => `UIKitControlTests/test${mode}Original${format}()`,
			);
			if (index === 5) controls.reverse();
			assert.equal(arm.ordinal, index + 1);
			assert.equal(arm.minutes, arm.release === "uikit" ? 45 : 50);
			assert.deepEqual(arm.setup, [
				"UIKitControlTests/testCancel()",
				`UIKitControlTests/testSeed${format}()`,
			]);
			assert.deepEqual(
				arm.cases,
				arm.release === "uikit" ? controls : [`ChooserUITests/test${format}()`],
			);
			paths.push(arm.directory);
		}
		plan.documents[0].name = "changed";
		plan.arms[0].setup.pop();
		plan.arms[0].cases.reverse();
		assert.equal(plan.arms[1].setup.length, 2);
		assert.equal(
			plan.arms[5].cases[0],
			`UIKitControlTests/testOpenOriginal${format}()`,
		);
		assert.equal(
			metadataFixture(m, experiment, framework).plan.documents[0].name,
			name,
		);
	}
	assert.equal(new Set(paths).size, paths.length);
	for (const experiment of ["metadata-regression", "metadata-restoration"])
		for (const [framework, device] of [
			["cordova-ios7", "iphone"],
			["cordova-ios8", "iphone"],
			["cordova-ios9", "ipad"],
			["cordova-ios8", "other"],
		])
			assert.throws(
				() =>
					m.createComparisonPlan({
						framework,
						device,
						output: "/tmp/rejected",
						experiment,
					}),
				/partition/,
			);
});

test("manual workflow shares exact regression/restoration targets and preserves existing matrices", () => {
	const workflow = readFileSync(
		join(__dirname, "../../.github/workflows/ios-release-comparison.yml"),
		"utf8",
	);
	const triggers = workflow.slice(
		workflow.indexOf("\non:"),
		workflow.indexOf("\npermissions:"),
	);
	assert.match(triggers, /workflow_dispatch:/);
	assert.doesNotMatch(triggers, /push:|pull_request:|schedule:|workflow_run:/);
	assert.match(
		triggers,
		/options:\s*\[\s*releases,\s*metadata-mode,\s*metadata-regression,\s*metadata-restoration,?\s*\]/,
	);
	assert.match(triggers, /default: releases/);
	const expression = workflow.match(/include: \$\{\{ (fromJSON\(.*\)) \}\}/)[1];
	for (const [experiment, expected] of [
		[
			"metadata-regression",
			[
				{ framework: "cordova-ios8", device: "ipad" },
				{ framework: "cordova-ios7", device: "ipad" },
			],
		],
		[
			"metadata-restoration",
			[
				{ framework: "cordova-ios8", device: "ipad" },
				{ framework: "cordova-ios7", device: "ipad" },
			],
		],
		["metadata-mode", [{ framework: "cordova-ios8", device: "ipad" }]],
		[
			"releases",
			["cordova-ios7", "cordova-ios8"].flatMap((framework) =>
				["iphone", "ipad"].map((device) => ({ framework, device })),
			),
		],
	])
		assert.deepEqual(
			JSON.parse(
				JSON.stringify(
					vm.runInNewContext(expression, {
						inputs: { experiment },
						fromJSON: JSON.parse,
					}),
				),
			),
			expected,
		);
	assert.match(
		workflow,
		/COMPARISON_EXPERIMENT: \$\{\{ inputs.experiment \}\}/,
	);
	assert.match(workflow, /"\$COMPARISON_EXPERIMENT"/);
	assert.match(workflow, /timeout-minutes: 360/);
	assert.match(workflow, /fail-fast: false/);
	assert.match(workflow, /cancel-in-progress: false/);
	assert.doesNotMatch(
		workflow,
		/continue-on-error|\|\| true|name: qualification-/,
	);
});

test("metadata-regression exact manifests reject substitutions, reused stores and incomplete target observations", async () => {
	const m = await loadModel();
	for (const framework of ["cordova-ios8", "cordova-ios7"]) {
		const { plan, context } = metadataFixture(
			m,
			"metadata-regression",
			framework,
		);
		const report = await m.runComparisonSchedule({
			plan,
			prepare: () => context,
			executeArm: ({ record, arm }) => completed(record, arm.ordinal),
			collectArm: () => {},
		});
		assert.equal(report.status, "passed");
		assert.deepEqual(report.context, context);
		m.checkComparisonResults(report, plan);
		for (const mutate of [
			(r) => r.arms.pop(),
			(r) => r.arms.push(r.arms[0]),
			(r) => r.arms.reverse(),
			(r) => (r.arms[1].release = "rc2"),
			(r) => (r.arms[2].udid = r.arms[1].udid),
			(r) => r.arms[1].cases.pop(),
			(r) => r.arms[1].cases.push(r.arms[1].cases[0]),
			(r) => (r.arms[1].cases[0].id = "ChooserUITests/testJSON()"),
			(r) => r.arms[5].cases.reverse(),
			(r) => r.arms[0].setup.pop(),
			(r) => r.arms[0].setup.reverse(),
			(r) =>
				r.arms[0].setup.push({
					id: "UIKitControlTests/testSeedJSON()",
					status: "passed",
				}),
			(r) => (r.arms[2].evidence.status = "failed"),
			(r) => (r.plan.documents[0].name = "fixture-json.json"),
			(r) => delete r.context.descriptors.rc1,
			(r) => (r.context.descriptors.rc1 = r.context.descriptors.rc2),
			(r) =>
				(r.context.descriptors.rc1.build = r.context.descriptors.rc2.build),
		]) {
			const copy = structuredClone(report);
			mutate(copy);
			assert.throws(() => m.checkComparisonResults(copy, plan));
		}
	}
});

test("metadata runners seed only their target, collect per-case provider logs and verify source hashes", async (t) => {
	const m = await load();
	for (const [experiment, framework] of metadataConfigurations)
		for (const fault of ["none", "seed", "original", "provider-log"])
			await t.test(`${experiment} ${framework}: ${fault}`, async (t) => {
				const directory = temporary(t),
					output = join(directory, "report"),
					assets = join(directory, "assets");
				const { plan, context } = metadataFixture(m, experiment, framework);
				const [{ format, name }] = plan.documents;
				mkdirSync(assets);
				writeFileSync(join(assets, name), "original bytes");
				let ordinal = 0,
					container,
					current,
					fixture;
				const executed = [];
				const spawn = t.mock.method(
					childProcess,
					"spawnSync",
					(monitor, argv) => {
						assert.equal(monitor, "python3");
						const [, , command, ...args] = argv;
						let stdout = "",
							status = 0;
						if (command === "/usr/bin/xcodebuild") {
							current =
								args
									.find((a) => a.startsWith("-only-testing:"))
									.split("/")
									.slice(-2)
									.join("/") + "()";
							assert.equal(
								args[args.indexOf("-derivedDataPath") + 1],
								join(output, "packages", fixture, "build/derived"),
							);
							executed.push([ordinal, current]);
							mkdirSync(args[args.indexOf("-resultBundlePath") + 1]);
							if (current === `UIKitControlTests/testSeed${format}()`)
								writeFileSync(
									join(container, "Documents", name),
									ordinal === 2 && fault === "seed"
										? "wrong seed"
										: "original bytes",
								);
							if (
								current === `ChooserUITests/test${format}()` &&
								ordinal === 2 &&
								fault === "original"
							)
								writeFileSync(
									join(container, "Documents", name),
									"changed original",
								);
						} else if (
							command === "/usr/bin/xcrun" &&
							args[0] === "xcresulttool"
						) {
							stdout = JSON.stringify(
								args[3] === "summary"
									? {
											totalTestCount: 1,
											passedTests: 1,
											failedTests: 0,
											skippedTests: 0,
										}
									: {
											testNodes: [
												{
													nodeType: "Test Case",
													nodeIdentifier: current,
													result: "Passed",
												},
											],
										},
							);
						} else if (command === "/usr/bin/xcrun" && args[0] === "simctl") {
							if (args[1] === "create") {
								ordinal++;
								const release = plan.arms[ordinal - 1].release;
								fixture =
									release === "uikit"
										? experiment === "metadata-regression"
											? "rc2"
											: "rc2-open"
										: release;
								stdout = `00000000-0000-0000-0000-${String(ordinal).padStart(12, "0")}`;
								container = join(directory, `sim-${ordinal}`);
								mkdirSync(join(container, "Documents"), { recursive: true });
								mkdirSync(join(container, "Library/Caches"), {
									recursive: true,
								});
								writeFileSync(
									join(container, "Library/Caches/chooser-fixture-events.log"),
									"callbacks",
								);
							}
							if (args[1] === "install") {
								assert.equal(
									args[3],
									join(
										output,
										"packages",
										fixture,
										"build/derived/Build/Products/Debug-iphonesimulator/ChooserVault.app",
									),
								);
							}
							if (args[1] === "get_app_container") stdout = container;
							if (args[1] === "spawn") {
								assert(args.includes("--predicate"));
								assert.match(
									args[args.indexOf("--predicate") + 1],
									/DocumentManager.*FileProvider.*CHOOSER_FIXTURE/,
								);
								stdout = "narrowed provider diagnostic";
								if (
									ordinal === 2 &&
									current === `ChooserUITests/test${format}()` &&
									args.includes("4m") &&
									fault === "provider-log"
								)
									status = 124;
							}
						} else assert.equal(command, process.execPath);
						return { status, signal: null, stdout, stderr: "" };
					},
				);
				syncBuiltinESMExports();
				t.after(() => {
					spawn.mock.restore();
					syncBuiltinESMExports();
				});
				let report;
				try {
					report = await m.verifyIosComparison({
						root: directory,
						framework,
						device: "ipad",
						experiment,
						output,
						prepare: ({ report }) => ({
							...context,
							env: {},
							assets,
							profile: { deviceType: "fake", runtime: "fake" },
							descriptors: Object.fromEntries(
								Object.entries(report.plan.packages).map(([release, paths]) => [
									release,
									{ ...context.descriptors[release], ...paths },
								]),
							),
						}),
					});
				} catch (error) {
					assert.notEqual(fault, "none", error.message);
					assert.match(error.message, /iOS comparison failed/);
					report = error.report;
				}
				assert.equal(report.status, fault === "none" ? "passed" : "failed");
				assert.equal(report.arms[5].status, "passed");
				assert.equal(new Set(report.arms.map((a) => a.udid)).size, 6);
				assert.deepEqual(
					executed,
					report.plan.arms.flatMap((arm) =>
						[...arm.setup, ...arm.cases].map((id) => [arm.ordinal, id]),
					),
				);
				for (const arm of report.arms) {
					assert.deepEqual(
						arm.sourcesBefore.map((f) => f.name),
						[name],
					);
					for (const item of [...arm.setup, ...arm.cases]) {
						assert.equal(item.xctestStatus, "passed");
						if (
							arm.id !== report.arms[1].id ||
							item.id !== `ChooserUITests/test${format}()` ||
							fault !== "provider-log"
						)
							assert.equal(
								readFileSync(item.artifacts.provider, "utf8"),
								"narrowed provider diagnostic",
							);
					}
					const sources = JSON.parse(
						readFileSync(
							join(output, "arms", arm.id, `${arm.id}-sources.json`),
						),
					);
					if (arm.id === report.arms[1].id && fault === "original") {
						assert.notDeepEqual(sources.after, sources.before);
						assert.match(
							arm.evidence.error.errors[0].message,
							/Selection changed provider originals/,
						);
					} else assert.deepEqual(sources.after, sources.before);
				}
				const failedArm = report.arms[1];
				if (fault === "seed")
					assert.match(
						failedArm.setup[1].seedError.message,
						/System-export seed changed bytes/,
					);
				if (fault === "provider-log") {
					assert.equal(failedArm.cases[0].status, "failed");
					assert.equal(failedArm.cases[0].providerError.code, "ETIMEDOUT");
				}
			});
});

test("metadata variants fix two reversed target repetitions with isolated descriptors", async () => {
	const m = await loadModel();
	const paths = [];
	const configurations = [
		...m.comparisonPartitions.map(({ framework, device }) => [
			"metadata-mode",
			framework,
			device,
		]),
		...metadataTargets.map(([framework]) => [
			"metadata-restoration",
			framework,
			"ipad",
		]),
	];
	for (const [experiment, framework, device] of configurations) {
		const format =
			experiment === "metadata-restoration" && framework === "cordova-ios7"
				? "PDF"
				: "Image";
		const plan = m.createComparisonPlan({
			framework,
			device,
			output: `/tmp/${experiment}-${framework}-${device}`,
			experiment,
		});
		assert.equal(plan.experiment, experiment);
		assert.deepEqual(plan.documents, [
			{
				format,
				name: format === "PDF" ? "fixture-pdf.pdf" : "fixture-image.png",
			},
		]);
		assert.deepEqual(plan.budgets, m.comparisonBudgets);
		assert.deepEqual(Object.keys(plan.packages), ["rc2-open", "rc2-import"]);
		for (const [release, descriptor] of Object.entries(plan.packages)) {
			assert.equal(descriptor.release, release);
			assert.equal(descriptor.comparisonRelease, "rc2");
			assert.equal(descriptor.metadataAsCopy, release === "rc2-import");
			for (const field of ["directory", "generated", "build", "evidence"])
				paths.push(descriptor[field]);
		}
		assert.deepEqual(
			plan.arms.map((arm) => arm.id),
			[
				"01-uikit",
				"02-rc2-open",
				"03-rc2-import",
				"04-rc2-import",
				"05-rc2-open",
				"06-uikit",
			],
		);
		assert.deepEqual(
			plan.arms.map((arm) => arm.release),
			["uikit", "rc2-open", "rc2-import", "rc2-import", "rc2-open", "uikit"],
		);
		assert.deepEqual(
			plan.arms.map((arm) => arm.cases),
			[
				[
					`UIKitControlTests/testImportOriginal${format}()`,
					`UIKitControlTests/testOpenOriginal${format}()`,
				],
				[`ChooserUITests/test${format}()`],
				[`ChooserUITests/test${format}()`],
				[`ChooserUITests/test${format}()`],
				[`ChooserUITests/test${format}()`],
				[
					`UIKitControlTests/testOpenOriginal${format}()`,
					`UIKitControlTests/testImportOriginal${format}()`,
				],
			],
		);
		for (const [index, arm] of plan.arms.entries()) {
			assert.equal(arm.ordinal, index + 1);
			assert.equal(arm.minutes, arm.release === "uikit" ? 45 : 50);
			assert.deepEqual(arm.setup, [
				"UIKitControlTests/testCancel()",
				`UIKitControlTests/testSeed${format}()`,
			]);
			paths.push(arm.directory);
		}
		// Neither repetitions nor separately created plans share mutable manifests.
		plan.documents[0].name = "changed";
		plan.arms[0].setup.pop();
		plan.arms[0].cases.reverse();
		assert.equal(plan.arms[1].setup.length, 2);
		assert.equal(
			plan.arms[5].cases[0],
			`UIKitControlTests/testOpenOriginal${format}()`,
		);
		assert.equal(m.comparisonDocuments[3].name, "fixture-image.png");
	}
	assert.equal(new Set(paths).size, paths.length);
});

test("focused metadata experiments retain provenance, deadlines and failed target outcomes without retries", async () => {
	const m = await loadModel();
	for (const [experiment, framework] of metadataConfigurations)
		for (const status of ["passed", "failed", "timed-out", "not-started"]) {
			const { plan, context } = metadataFixture(m, experiment, framework);
			let time = 0;
			const attempted = [],
				collected = [];
			const report = await m.runComparisonSchedule({
				plan,
				now: () => time,
				prepare: ({ deadline }) => {
					assert.equal(deadline, 35 * 60000);
					time = deadline - 1;
					return context;
				},
				executeArm: ({ arm, record, deadline }) => {
					assert.equal(deadline - time, arm.minutes * 60000);
					attempted.push(arm.id);
					completed(record, arm.ordinal);
					if (arm.ordinal === 2) record.cases[0].status = status;
					time = deadline - 1;
				},
				collectArm: ({ arm, deadline }) => {
					assert.equal(deadline - time, 150000);
					collected.push(arm.id);
					time = deadline - 1;
				},
			});
			assert.equal(report.status, status === "passed" ? "passed" : "failed");
			assert.equal(report.arms[1].cases[0].status, status);
			assert.equal(report.arms[5].status, "passed");
			assert.deepEqual(
				attempted,
				plan.arms.map((arm) => arm.id),
			);
			assert.deepEqual(collected, attempted);
			assert(time <= 340 * 60000);
			assert.equal(report.plan.budgets.caseSeconds, 180);
			const serialized = JSON.parse(JSON.stringify(report));
			assert.deepEqual(serialized.plan, plan);
			assert.deepEqual(serialized.context, context);
			assert.deepEqual(
				serialized.arms.map((arm) => arm.release),
				plan.arms.map((arm) => arm.release),
			);
		}
});

test("metadata variant results reject substitution, reused stores and incomplete observations", async () => {
	const m = await loadModel();
	for (const [experiment, framework] of metadataConfigurations.filter(
		([experiment]) => experiment !== "metadata-regression",
	)) {
		const { plan, context } = metadataFixture(m, experiment, framework);
		const otherFormat = plan.documents[0].format === "PDF" ? "Image" : "PDF";
		const report = await m.runComparisonSchedule({
			plan,
			prepare: () => context,
			executeArm: ({ record, arm }) => completed(record, arm.ordinal),
			collectArm: () => {},
		});
		m.checkComparisonResults(report, plan);
		for (const mutate of [
			(r) => r.arms.pop(),
			(r) => r.arms.push(r.arms[0]),
			(r) => r.arms.reverse(),
			(r) => (r.arms[1].release = "rc2-import"),
			(r) => (r.arms[2].release = "rc2"),
			(r) => (r.arms[2].udid = r.arms[1].udid),
			(r) => r.arms[1].cases.pop(),
			(r) => r.arms[1].cases.push(r.arms[1].cases[0]),
			(r) => (r.arms[1].cases[0].id = `ChooserUITests/test${otherFormat}()`),
			(r) => (r.arms[1].cases[0].status = "failed"),
			(r) => (r.arms[1].cases[0].status = "timed-out"),
			(r) => (r.arms[1].cases[0].status = "skipped"),
			(r) => r.arms[5].cases.reverse(),
			(r) => r.arms[0].setup.pop(),
			(r) => r.arms[0].setup.reverse(),
			(r) =>
				r.arms[0].setup.push({
					id: "UIKitControlTests/testSeedJSON()",
					status: "passed",
				}),
			(r) => (r.arms[2].evidence.status = "failed"),
			(r) => (r.plan.documents[0].name = "fixture-json.json"),
			(r) => (r.plan.packages["rc2-import"].metadataAsCopy = false),
			(r) => delete r.context.descriptors["rc2-import"],
			(r) =>
				(r.context.descriptors["rc2-import"] =
					r.context.descriptors["rc2-open"]),
			(r) => (r.context.descriptors["rc2-import"].metadataAsCopy = false),
			(r) => (r.context.descriptors["rc2-open"].comparisonRelease = "rc2-open"),
			(r) =>
				(r.context.descriptors["rc2-import"].build =
					r.context.descriptors["rc2-open"].build),
		]) {
			const copy = structuredClone(report);
			mutate(copy);
			assert.throws(() => m.checkComparisonResults(copy, plan));
		}
	}
});

test("fixed stage/deadline budget is at most 340 minutes including evidence, with 20 workflow headroom", async () => {
	const m = await load();
	let time = 0;
	const seen = [];
	const plan = m.createComparisonPlan({
		framework: "cordova-ios8",
		device: "ipad",
		output: "/tmp/budget",
	});
	const report = await m.runComparisonSchedule({
		plan,
		now: () => time,
		prepare: ({ deadline }) => {
			assert.equal(deadline, 35 * 60000);
			time = deadline - 1;
			return {};
		},
		executeArm: ({ arm, record, deadline }) => {
			assert.equal(deadline - time, arm.minutes * 60000);
			seen.push(arm.id);
			completed(record, arm.ordinal);
			time = deadline - 1;
		},
		collectArm: ({ deadline }) => {
			assert.equal(deadline - time, 150000);
			time = deadline - 1;
		},
	});
	assert.equal(report.status, "passed");
	assert(time <= 340 * 60000);
	assert.equal(seen.length, 6);
	assert.equal(
		m.comparisonBudgets.workflowMinutes - m.comparisonBudgets.jobMinutes,
		20,
	);
	assert.equal(m.comparisonBudgets.caseSeconds, 180);
	assert.equal(m.comparisonTimeout(5000, 2000, 1000), 1000);
	assert.throws(() => m.comparisonTimeout(2000, 2000), { code: "ETIMEDOUT" });
});

test("a failed/timed out arm and failed diagnostics retain every later arm without retries", async () => {
	const attempted = [],
		collected = [];
	const { report } = await schedule({
		executeArm: ({ arm, record }) => {
			attempted.push(arm.id);
			if (arm.ordinal === 2) {
				record.cases[0].status = "timed-out";
				throw Object.assign(new Error("deadline"), { code: "ETIMEDOUT" });
			}
			completed(record, arm.ordinal);
		},
		collectArm: ({ arm }) => {
			collected.push(arm.id);
			if (arm.ordinal === 3) throw new Error("export failed");
		},
	});
	assert.equal(report.status, "failed");
	assert.equal(report.arms[1].status, "timed-out");
	assert.equal(report.arms[1].cases[1].status, "not-started");
	assert.equal(report.arms[2].evidence.status, "failed");
	assert.equal(report.arms[5].status, "passed");
	assert.deepEqual(attempted, collected);
	assert.equal(attempted.length, 6);
});

test("shared preparation failure creates comparison.json and explicit missing arms before throwing", async (t) => {
	const m = await load();
	const output = join(temporary(t), "report");
	let called = false;
	await assert.rejects(
		m.verifyIosComparison({
			framework: "cordova-ios7",
			device: "iphone",
			output,
			prepare: () => {
				throw new Error("bad integrity");
			},
			executeArm: () => {
				called = true;
			},
		}),
		/comparison failed/,
	);
	assert.equal(called, false);
	const report = JSON.parse(readFileSync(join(output, "comparison.json")));
	assert.equal(report.status, "failed");
	assert.equal(report.prepare.status, "failed");
	assert.equal(report.arms.length, 6);
	assert(
		report.arms.every(
			(a) =>
				a.status === "not-started" &&
				a.cases.every((c) => c.status === "not-started"),
		),
	);
	for (const arm of report.plan.arms)
		assert(existsSync(join(arm.directory, `${arm.id}-not-started.json`)));
	await assert.rejects(
		m.verifyIosComparison({
			framework: "cordova-ios7",
			device: "iphone",
			output,
		}),
		/already exists/,
	);
});

test("exact result manifest rejects failed, skipped, missing, duplicate, unexpected and reordered cases/arms", async () => {
	const { m, plan, report } = await schedule();
	m.checkComparisonResults(report, plan);
	for (const mutate of [
		(r) => r.arms.pop(),
		(r) => r.arms.push(r.arms[0]),
		(r) => r.arms.reverse(),
		(r) => r.arms[0].cases.pop(),
		(r) => r.arms[0].cases.push(r.arms[0].cases[0]),
		(r) => r.arms[0].cases.reverse(),
		(r) => r.arms[0].setup.pop(),
		(r) => (r.arms[0].cases[0].id = "ChooserUITests/testSwipePromiseReopen()"),
		(r) => (r.arms[0].cases[0].status = "not-started"),
		(r) => (r.arms[0].cases[0].status = "failed"),
		(r) => (r.arms[0].cases[0].status = "skipped"),
		(r) => (r.arms[0].evidence.status = "failed"),
		(r) => (r.arms[1].udid = r.arms[0].udid),
		(r) => (r.plan.budgets.caseSeconds = 999),
	]) {
		const copy = structuredClone(report);
		mutate(copy);
		assert.throws(() => m.checkComparisonResults(copy, plan));
	}
});

test("UI-only RC1 scheme excludes native contracts; native selection builds and runs without provider fixtures", async (t) => {
	const { prepareIosSimulatorFixture, simulatorNativeOnly } =
		await import("../../scripts/ios-simulator.mjs");
	assert.equal(
		simulatorNativeOnly({
			chooser: ["ChooserPickerTests/testExample()"],
			control: [],
		}),
		true,
	);
	assert.equal(
		simulatorNativeOnly({
			chooser: ["ChooserUITests/testJSON()"],
			control: [],
		}),
		false,
	);
	assert.equal(simulatorNativeOnly({ chooser: [], control: [] }), false);
	const base = temporary(t),
		root = join(__dirname, "../..");
	const generated = join(base, "generated");
	mkdirSync(join(generated, "platforms/ios/www"), { recursive: true });
	mkdirSync(join(generated, "platforms/ios/ChooserFixture"), {
		recursive: true,
	});
	writeFileSync(
		join(generated, "platforms/ios/ChooserFixture/config.xml"),
		"<widget/>",
	);
	const commands = [];
	const run = (cmd, args) => {
		commands.push({ cmd, args });
		return "";
	};
	for (const nativeOnly of [false, true]) {
		const directory = join(base, nativeOnly ? "native" : "rc1");
		prepareIosSimulatorFixture({
			root,
			generated,
			packed: root,
			directory,
			alias: "cordova-ios7",
			run,
			env: {},
			uiOnly: !nativeOnly,
			nativeOnly,
			clean: false,
			...(!nativeOnly
				? {
						adapter: join(root, "scripts/ios-comparison-adapter.cjs"),
						comparisonRelease: "rc1",
					}
				: {}),
		});
		const spec = JSON.parse(readFileSync(join(directory, "project.json")));
		if (nativeOnly) {
			assert.deepEqual(Object.keys(spec.schemes), ["ChooserNative"]);
			assert(
				!spec.targets.UIKitControl &&
					!spec.targets.ChooserVault &&
					!spec.targets.ChooserUITests,
			);
		} else {
			assert(!spec.targets.ChooserPickerTests);
			assert.deepEqual(spec.schemes.ChooserUI.test.targets, ["ChooserUITests"]);
			assert.match(
				readFileSync(join(directory, "www/index.html"), "utf8"),
				/iosComparisonRelease = "rc1"/,
			);
		}
	}
	const nativeCommands = commands
		.filter((c) => c.cmd === "/usr/bin/xcodebuild")
		.slice(-1);
	assert.equal(nativeCommands.length, 1);
	assert(nativeCommands[0].args.includes("ChooserNative"));
});
