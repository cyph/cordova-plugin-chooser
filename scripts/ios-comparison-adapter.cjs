/* Shared verbatim by the browser fixture and the tooling tests. */
(function (scope) {
	async function metadata(chooser, release, accept) {
		if (release !== "rc1" && release !== "rc2")
			throw new TypeError("Unknown comparison release");
		try {
			const file = await chooser.getFileMetadata(
				release === "rc1" ? accept : { accept },
			);
			if (release === "rc1" && file === undefined)
				return { outcome: "canceled" };
			if (!file || typeof file.name !== "string")
				throw new TypeError("Invalid metadata result");
			return { outcome: "selected", file };
		} catch (error) {
			if (
				release === "rc2" &&
				typeof chooser.CancellationError === "function" &&
				error instanceof chooser.CancellationError
			)
				return { outcome: "canceled" };
			throw error;
		}
	}
	if (typeof module === "object" && module.exports)
		module.exports = { metadata };
	else scope.iosComparisonMetadata = metadata;
})(globalThis);
