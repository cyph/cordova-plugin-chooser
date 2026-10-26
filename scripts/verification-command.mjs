import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const monitor = fileURLToPath(
	new URL("./verification-command.py", import.meta.url),
);

export function spawnVerified(command, args, options) {
	const { timeout, ...rest } = options;
	assert(
		Number.isSafeInteger(timeout) && timeout > 0,
		"Expected a positive command timeout",
	);
	return spawnSync(
		"python3",
		[monitor, String(timeout / 1000), command, ...args],
		{
			...rest,
			// Allow the monitor to terminate and reap its owned group. If output
			// exceeds maxBuffer, SIGTERM makes the monitor kill that group too.
			timeout: timeout + 15_000,
			killSignal: "SIGTERM",
		},
	);
}
