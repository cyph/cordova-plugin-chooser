const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("Actions updates own every tracked workflow selected by their adapter", () => {
	const result = spawnSync(
		"python3",
		[
			"-c",
			`import fnmatch,json,pathlib,subprocess,tomllib
updates=tomllib.loads(pathlib.Path('chainman/updates.toml').read_text())['updates']
adapter=updates['adapters']['github']
tracked=subprocess.check_output(['git','ls-files','-z','.github/workflows']).decode().split('\\0')
selected=[p for p in tracked if p and any(fnmatch.fnmatchcase(p, pattern) for pattern in adapter['files'])]
missing=[p for p in selected if not any(fnmatch.fnmatchcase(p, pattern) for pattern in updates['outputs'])]
print(json.dumps({'selected':selected,'missing':missing}))`,
		],
		{ cwd: join(__dirname, "../.."), encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const { selected, missing } = JSON.parse(result.stdout);
	assert(
		selected.length > 0,
		"Expected tracked workflows selected for updates",
	);
	assert.deepEqual(
		missing,
		[],
		"Selected workflows need authorized update outputs",
	);
});

test("stale-event mutations are a manual Chainman task isolated from release evidence", () => {
	const root = join(__dirname, "../..");
	const parsed = spawnSync(
		"python3",
		[
			"-c",
			"import json,tomllib; print(json.dumps(tomllib.load(open('chainman.toml','rb'))))",
		],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(parsed.status, 0, parsed.stderr);
	const task = JSON.parse(parsed.stdout).tasks["verify-ios-stale-events"];
	assert.equal(task.profile, "ios");
	assert.deepEqual(task.setup, ["javascript"]);
	assert.deepEqual(task.commands, [["node", "scripts/ios-stale-events.mjs"]]);
	assert.equal(task.cleanup_children, true);
	const workflow = readFileSync(
		join(root, ".github/workflows/ios-stale-events.yml"),
		"utf8",
	);
	assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
	assert.doesNotMatch(
		workflow,
		/^  (push|pull_request|schedule|workflow_call):/m,
	);
	assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
	assert.match(workflow, /chainman run verify-ios-stale-events/);
	assert.match(
		workflow,
		/name: diagnostics-stale-events-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
	);
	assert.doesNotMatch(
		workflow,
		/continue-on-error|npm-publish|attest create|qualification-|qualified-release-|\.verification\/reports\//,
	);
	assert.match(workflow, /git diff --exit-code/);
	assert.match(workflow, /git diff --cached --exit-code/);
	assert.match(workflow, /tests\.xcresult/);
	assert.match(workflow, /if-no-files-found: error/);
});
