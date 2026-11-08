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

// The experimental package differs at one picker argument. Preserve the
// unmodified archive and record both identities; never describe this as a
// published release or modify the checkout used to produce it.
export function applyMetadataImportExperiment(directory) {
	const path = join(directory, "src/ios/Chooser.swift");
	const before = readFileSync(path, "utf8");
	const original =
		"ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: false)";
	const replacement =
		"ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: request.mode == .metadata)";
	assert.equal(
		before.split(original).length,
		2,
		"Expected exactly one unmodified picker initializer",
	);
	writeFileSync(path, before.replace(original, replacement));
	return { path: "src/ios/Chooser.swift", original, replacement };
}

export function prepareComparisonDescriptors({ root, plan, run }) {
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
	const descriptors = {};
	for (const release of Object.keys(plan.packages)) {
		const paths = plan.packages[release];
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
			if (release === "rc2-import") {
				packSource = join(paths.directory, "experimental-source");
				cpSync(source, packSource, { recursive: true });
				experimentPatch = applyMetadataImportExperiment(packSource);
			}
			[pack] = JSON.parse(
				run(
					"npm",
					[
						"pack",
						"--json",
						"--ignore-scripts",
						"--pack-destination",
						paths.directory,
					],
					packSource,
					true,
				),
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
			...(release === "rc1" ? { url: rc1.url } : { commit, tree }),
		};
		if (release === "rc2-import") {
			const baseline = descriptors["rc2-open"];
			assert(baseline, "Unmodified RC2 must be prepared first");
			assert.deepEqual(
				descriptors[release].files.filter(
					(file) => file.name !== "src/ios/Chooser.swift",
				),
				baseline.files.filter((file) => file.name !== "src/ios/Chooser.swift"),
				"Metadata experiment changed other package files",
			);
			descriptors[release].experiment = {
				kind: "metadata-import",
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
	return {
		source,
		commit,
		tree,
		trackedClean: true,
		sourceArchive: archive,
		sourceIntegrity: comparisonIntegrity(readFileSync(archive)),
		descriptors,
	};
}
