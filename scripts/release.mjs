import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackedFiles, packedPackage } from "./package.mjs";
import { pinnedNpm } from "./npm.mjs";

const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));

function execute(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: "pipe",
	});
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		`${command} failed:\n${result.stdout}${result.stderr}`,
	);
	return result.stdout.trim();
}

function executeInteractive(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		`${command} failed (${result.signal ?? `exit ${result.status}`})`,
	);
}

// Read identity without extracting archive paths into the checkout or staging tree.
const archiveIdentity = `import json,pathlib,sys,tarfile
with tarfile.open(sys.argv[1]) as t:
 names=set()
 for m in t.getmembers():
  p=pathlib.PurePosixPath(m.name)
  assert not p.is_absolute() and '..' not in p.parts and p.parts[0]=='package', 'Unsafe package path'
  assert m.isfile() or m.isdir(), 'Package links are not supported'
  assert m.name not in names, 'Duplicate package path'
  names.add(m.name)
 manifest=json.load(t.extractfile('package/package.json'))
 print(json.dumps({'name':manifest['name'],'version':manifest['version']}))`;

export function releaseManifest({
	archive,
	commit,
	integrity,
	pkg,
	run = execute,
}) {
	assert.match(
		commit,
		/^[a-f0-9]{40}$/,
		"Release requires a full source commit",
	);
	assert(lstatSync(archive).isFile(), "Release archive must be a regular file");
	const digest = createHash("sha512").update(readFileSync(archive)).digest();
	assert.equal(
		`sha512-${digest.toString("base64")}`,
		integrity,
		"Release archive integrity mismatch",
	);
	const identity = JSON.parse(
		run("python3", ["-c", archiveIdentity, archive], dirname(archive)),
	);
	assert.deepEqual(
		identity,
		{ name: pkg.name, version: pkg.version },
		"Release archive name/version mismatch",
	);
	return {
		version: 1,
		sourceCommit: commit,
		artifacts: [
			{
				path: relative(dirname(archive), archive),
				subject: `pkg:npm/${pkg.name.replace(/^@/, "%40")}@${pkg.version}`,
				digest: { sha512: digest.toString("hex") },
			},
		],
	};
}

function saveManifest(directory, options) {
	const manifest = releaseManifest(options);
	const path = join(directory, "manifest.json");
	writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
	chmodSync(options.archive, 0o444);
	return path;
}

export function prepareCiRelease({ root, integrity, commit, run = execute }) {
	const pkg = readJSON(join(root, "package.json"));
	const filename = `${pkg.name}-${pkg.version}.tgz`;
	const directory = join(root, ".verification/release");
	mkdirSync(directory, { recursive: true });
	const archive = join(directory, filename);
	cpSync(join(root, ".verification/release-input/portable", filename), archive);
	return saveManifest(directory, { archive, commit, integrity, pkg, run });
}

export function publishRelease({
	root,
	runId,
	run = execute,
	runInteractive = executeInteractive,
	npm = () => pinnedNpm(root),
}) {
	assert.match(runId ?? "", /^[1-9]\d*$/, "Pass one GitHub Actions run ID");
	const clean = () =>
		assert.equal(
			run("git", ["status", "--porcelain", "--untracked-files=normal"], root),
			"",
			"Release publication requires a clean checkout",
		);
	clean();
	const commit = run("git", ["rev-parse", "HEAD"], root);
	assert.match(commit, /^[a-f0-9]{40}$/);
	const output = join(root, ".verification");
	mkdirSync(output, { recursive: true });
	const directory = mkdtempSync(join(output, "release-local-"));
	const source = join(directory, "source");
	mkdirSync(source);
	const snapshot = join(directory, "source.tar");
	run("git", ["archive", "--format=tar", `--output=${snapshot}`, commit], root);
	run(
		"python3",
		["-m", "tarfile", "--extract", snapshot, source, "--filter", "data"],
		root,
	);
	const pkg = readJSON(join(source, "package.json"));
	const packer = npm();
	const info = packedPackage(
		run(
			packer.command,
			[
				...packer.args,
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				directory,
			],
			source,
		),
		pkg.name,
	);
	assert.equal(
		info.filename,
		`${pkg.name}-${pkg.version}.tgz`,
		"Unexpected npm archive filename",
	);
	checkPackedFiles(
		source,
		pkg,
		info.files.map(({ path }) => path),
	);
	const manifest = saveManifest(directory, {
		archive: join(directory, info.filename),
		commit,
		integrity: info.integrity,
		pkg,
		run,
	});
	clean();
	assert.equal(
		run("git", ["rev-parse", "HEAD"], root),
		commit,
		"HEAD changed while preparing the release",
	);
	// The helper independently checks the successful run, exact attempt, qualified
	// HEAD, PURL, digest, signer and retained bundle before publishing these bytes.
	runInteractive(
		"just",
		["chainman", "npm-publish", relative(root, manifest), "--run", runId],
		root,
	);
	return manifest;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	if (process.argv[2] === "ci" && process.argv.length === 4) {
		prepareCiRelease({
			root,
			integrity: process.argv[3],
			commit: process.env.GITHUB_SHA,
		});
	} else if (process.argv[2] === "publish" && process.argv.length === 4) {
		publishRelease({ root, runId: process.argv[3] });
	} else
		throw new Error(
			"Usage: node scripts/release.mjs ci INTEGRITY | publish RUN_ID",
		);
}
