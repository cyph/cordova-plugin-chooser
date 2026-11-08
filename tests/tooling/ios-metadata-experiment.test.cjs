const assert = require("node:assert/strict");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");

test("metadata mode experiment changes one argument and rejects source drift", async (t) => {
	const { applyMetadataModeExperiment, comparisonMetadataAsCopy } =
		await import("../../scripts/ios-comparison-packages.mjs");
	const directory = mkdtempSync(join(tmpdir(), "chooser-metadata-mode-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "src/ios"), { recursive: true });
	const path = join(directory, "src/ios/Chooser.swift");
	const source = readFileSync(
		join(__dirname, "../../src/ios/Chooser.swift"),
		"utf8",
	);
	writeFileSync(path, source);
	assert.equal(comparisonMetadataAsCopy(directory), true);
	const patch = applyMetadataModeExperiment(directory, false);
	assert.equal(patch.path, "src/ios/Chooser.swift");
	assert.equal(
		readFileSync(path, "utf8"),
		source.replace(patch.original, patch.replacement),
	);
	assert.equal(patch.replacement.split("asCopy: ")[1], "false)");
	assert.throws(
		() => applyMetadataModeExperiment(directory, false),
		/must change/,
	);
	applyMetadataModeExperiment(directory, true);
	assert.equal(readFileSync(path, "utf8"), source);
	for (const invalid of ["unexpected source", `${source}\n${source}`]) {
		writeFileSync(path, invalid);
		assert.throws(
			() => applyMetadataModeExperiment(directory, false),
			/exactly one/,
		);
		assert.equal(readFileSync(path, "utf8"), invalid);
	}
});
