import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { rc1, comparisonIntegrity } from "./ios-comparison-model.mjs";
import { pinnedNpm } from "./npm.mjs";
import { packedPackage } from "./package.mjs";

export function comparisonFiles(directory) {
	const files = [];
	function visit(folder) {
		for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) visit(path);
			else {
				assert(entry.isFile(), `Unexpected comparison source entry: ${path}`);
				const bytes = readFileSync(path);
				files.push({
					name: relative(directory, path),
					size: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				});
			}
		}
	}
	visit(directory);
	return files;
}

export function checkComparisonPackage(directory, release) {
	const manifest = JSON.parse(
		readFileSync(join(directory, "package.json"), "utf8"),
	);
	assert.equal(manifest.name, rc1.name, "Unexpected comparison package name");
	assert.equal(
		manifest.version,
		release === "rc1" ? rc1.version : "2.0.0-rc.2",
		"Unexpected comparison package version",
	);
	for (const path of ["plugin.xml", "src/ios", manifest.main]) {
		assert(
			typeof path === "string" && existsSync(join(directory, path)),
			"Incomplete comparison package",
		);
	}
	return manifest;
}

const metadataPickerPath = "src/ios/Chooser.swift";
const metadataPickerInitializers = [
	"ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: false)",
	"ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: request.mode == .metadata)",
];

export function comparisonMetadataAsCopy(directory) {
	const source = readFileSync(join(directory, metadataPickerPath), "utf8");
	const known = metadataPickerInitializers.filter((value) =>
		source.includes(value),
	);
	assert(
		(source.match(/\bChooserDocumentPicker\s*\(/g) ?? []).length === 1 &&
			known.length === 1,
		"Expected exactly one known comparison picker initializer",
	);
	return known[0] === metadataPickerInitializers[1];
}

export function comparisonPluginAsCopy(descriptors) {
	return Object.fromEntries(
		Object.entries(descriptors).map(([release, descriptor]) => {
			assert(
				["rc1", "rc2", "rc2-open", "rc2-import"].includes(release),
				"Unknown comparison release",
			);
			const asCopy =
				release === "rc1" ? true : comparisonMetadataAsCopy(descriptor.package);
			if (descriptor.metadataAsCopy !== undefined)
				assert.equal(
					asCopy,
					descriptor.metadataAsCopy,
					"Comparison package mode mismatch",
				);
			return [release, asCopy];
		}),
	);
}

// Patch only an isolated copy of the committed source. Both directions use
// exact known initializers; the canonical package is never an experiment.
export function applyMetadataModeExperiment(directory, asCopy) {
	assert.equal(typeof asCopy, "boolean", "Unknown metadata picker mode");
	const beforeMode = comparisonMetadataAsCopy(directory);
	assert.notEqual(
		beforeMode,
		asCopy,
		"Metadata experiment must change picker mode",
	);
	const path = join(directory, metadataPickerPath);
	const before = readFileSync(path, "utf8");
	const original = metadataPickerInitializers[Number(beforeMode)];
	const replacement = metadataPickerInitializers[Number(asCopy)];
	writeFileSync(path, before.replace(original, replacement));
	return { path: metadataPickerPath, original, replacement };
}

// Preserve the original helper's false-source import experiment.
export function applyMetadataImportExperiment(directory) {
	return applyMetadataModeExperiment(directory, true);
}

export function prepareComparisonDescriptors({
	root,
	plan,
	run,
	npm = () => pinnedNpm(root),
}) {
	// Ignore untracked evidence, but never describe tracked local edits as a
	// committed RC2 candidate. Archive the resolved object, never the worktree.
	assert.equal(
		run("git", ["status", "--porcelain", "--untracked-files=no"], root, true),
		"",
		"Comparison requires clean tracked source",
	);
	const commit = run("git", ["rev-parse", "HEAD"], root, true);
	assert.match(commit, /^[0-9a-f]{40,64}$/);
	const tree = run("git", ["rev-parse", `${commit}^{tree}`], root, true);
	const source = join(plan.output, "source");
	mkdirSync(source);
	const archive = join(plan.output, "rc2-source.tar");
	run("git", ["archive", "--format=tar", `--output=${archive}`, commit], root);
	run("tar", ["-xf", archive, "-C", source], root);
	const sourceAsCopy = comparisonMetadataAsCopy(source);
	const releases = Object.keys(plan.packages);
	assert(
		releases.every((release) =>
			["rc1", "rc2", "rc2-open", "rc2-import"].includes(release),
		),
		"Unknown comparison release",
	);
	const variants =
		releases.includes("rc2-open") || releases.includes("rc2-import");
	if (variants)
		assert.deepEqual(
			releases,
			["rc2-open", "rc2-import"],
			"Incorrect metadata variants",
		);
	const canonicalRelease = variants
		? sourceAsCopy
			? "rc2-import"
			: "rc2-open"
		: "rc2";
	// Prepare the actual baseline first, preserving the plan and returned order.
	const preparationOrder = variants
		? [
				canonicalRelease,
				...releases.filter((release) => release !== canonicalRelease),
			]
		: releases;
	const sourceFiles = comparisonFiles(source);
	const descriptors = {};
	for (const release of preparationOrder) {
		const paths = plan.packages[release];
		const metadataAsCopy = variants ? release === "rc2-import" : sourceAsCopy;
		if (variants)
			assert.equal(
				paths.metadataAsCopy,
				metadataAsCopy,
				"Incorrect metadata variant mode",
			);
		mkdirSync(paths.directory, { recursive: true });
		mkdirSync(paths.evidence);
		let tarball;
		let pack;
		let experimentPatch;
		if (release === "rc1") {
			tarball = join(paths.directory, "cordova-plugin-chooser-2.0.0-rc.1.tgz");
			run(
				"curl",
				[
					"--fail",
					"--location",
					"--proto",
					"=https",
					"--max-time",
					"120",
					"--output",
					tarball,
					rc1.url,
				],
				root,
			);
		} else {
			let packSource = source;
			if (metadataAsCopy !== sourceAsCopy) {
				packSource = join(paths.directory, "experimental-source");
				cpSync(source, packSource, { recursive: true });
				experimentPatch = applyMetadataModeExperiment(
					packSource,
					metadataAsCopy,
				);
			}
			const packer = npm();
			pack = packedPackage(
				run(
					packer.command,
					[
						...packer.args,
						"pack",
						"--json",
						"--ignore-scripts",
						"--pack-destination",
						paths.directory,
					],
					packSource,
					true,
				),
				rc1.name,
			);
			assert(
				pack &&
					typeof pack.filename === "string" &&
					!pack.filename.includes("/"),
				"Invalid npm pack output",
			);
			tarball = join(paths.directory, pack.filename);
			writeFileSync(
				join(paths.evidence, "pack.json"),
				JSON.stringify(pack, null, 2) + "\n",
			);
		}
		const integrity = comparisonIntegrity(
			readFileSync(tarball),
			release === "rc1" ? rc1.integrity : pack.integrity,
		);
		process.stdout.write(`Comparison ${release} package: ${integrity}\n`);
		const unpacked = join(paths.directory, "unpacked");
		mkdirSync(unpacked);
		// Check identity before extracting any package into the installation
		// source. Also reject links and traversals, even in an integrity-pinned tar.
		run(
			"python3",
			[
				"-c",
				`import json,pathlib,sys,tarfile
with tarfile.open(sys.argv[1]) as t:
 for m in t.getmembers():
  p=pathlib.PurePosixPath(m.name)
  assert not p.is_absolute() and '..' not in p.parts and p.parts[0]=='package'
  assert m.isfile() or m.isdir(), 'Package links are not supported'
 manifest=json.load(t.extractfile('package/package.json'))
 assert manifest['name']==sys.argv[3] and manifest['version']==sys.argv[4], 'Unexpected comparison package identity'
 t.extractall(sys.argv[2], filter='data')`,
				tarball,
				unpacked,
				rc1.name,
				release === "rc1" ? rc1.version : "2.0.0-rc.2",
			],
			root,
		);
		const directory = join(unpacked, "package");
		const manifest = checkComparisonPackage(directory, release);
		cpSync(
			join(directory, "package.json"),
			join(paths.evidence, "package.json"),
		);
		descriptors[release] = {
			...paths,
			name: manifest.name,
			version: manifest.version,
			tarball,
			integrity,
			package: directory,
			files: comparisonFiles(directory),
			...(release === "rc1"
				? { url: rc1.url }
				: { commit, tree, metadataAsCopy }),
		};
		if (release !== "rc1") {
			assert.equal(
				comparisonMetadataAsCopy(directory),
				metadataAsCopy,
				"Comparison package mode mismatch",
			);
			if (!experimentPatch) {
				assert.equal(
					readFileSync(join(directory, metadataPickerPath), "utf8"),
					readFileSync(join(source, metadataPickerPath), "utf8"),
					"Canonical package changed picker source",
				);
				for (const file of descriptors[release].files)
					assert.deepEqual(
						file,
						sourceFiles.find((original) => original.name === file.name),
						"Canonical package changed committed source",
					);
			}
		}
		if (experimentPatch) {
			const baseline = descriptors[canonicalRelease];
			assert(baseline, "Unmodified RC2 must be prepared first");
			assert.deepEqual(
				descriptors[release].files.filter(
					(file) => file.name !== "src/ios/Chooser.swift",
				),
				baseline.files.filter((file) => file.name !== "src/ios/Chooser.swift"),
				"Metadata experiment changed other package files",
			);
			assert.equal(
				readFileSync(join(directory, metadataPickerPath), "utf8"),
				readFileSync(
					join(baseline.package, metadataPickerPath),
					"utf8",
				).replace(experimentPatch.original, experimentPatch.replacement),
				"Metadata experiment changed more than its exact picker argument",
			);
			descriptors[release].experiment = {
				kind: metadataAsCopy ? "metadata-import" : "metadata-open",
				baseIntegrity: baseline.integrity,
				changedFile: "src/ios/Chooser.swift",
				patch: experimentPatch,
			};
		}
		writeFileSync(
			join(paths.evidence, "descriptor.json"),
			JSON.stringify(descriptors[release], null, 2) + "\n",
		);
	}
	assert.deepEqual(
		comparisonFiles(source),
		sourceFiles,
		"Committed comparison source changed",
	);
	return {
		source,
		commit,
		tree,
		trackedClean: true,
		sourceArchive: archive,
		sourceIntegrity: comparisonIntegrity(readFileSync(archive)),
		descriptors: Object.fromEntries(
			releases.map((release) => [release, descriptors[release]]),
		),
	};
}
