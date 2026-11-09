const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

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
