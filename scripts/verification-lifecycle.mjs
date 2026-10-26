import { setTimeout as delay } from "node:timers/promises";

// Keep the original failure while attempting every independent cleanup step.
function finish(value, errors) {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, errors[0].message, { cause: errors[0] });
	return value;
}

export function withFinalizers(action, finalizers) {
	const errors = [];
	let value;
	try {
		value = action();
	} catch (error) {
		errors.push(error);
	}
	for (const finalize of finalizers) {
		try {
			finalize();
		} catch (error) {
			errors.push(error);
		}
	}
	return finish(value, errors);
}

export async function withAsyncFinalizers(action, finalizers) {
	const errors = [];
	let value;
	try {
		value = await action();
	} catch (error) {
		errors.push(error);
	}
	for (const finalize of finalizers) {
		try {
			await finalize();
		} catch (error) {
			errors.push(error);
		}
	}
	return finish(value, errors);
}

const stoppedChildren = new WeakSet();

// Call only for a child spawned with detached: true. Its descendants retain
// the owned process group even when the original child exits first.
export async function stopOwnedChild(child, milliseconds = 5_000) {
	if (!child?.pid || stoppedChildren.has(child)) return;
	const signalGroup = (signal) => {
		try {
			process.kill(-child.pid, signal);
			return true;
		} catch (error) {
			if (error.code === "ESRCH") return false;
			throw error;
		}
	};
	const wait = async () => {
		const end = performance.now() + milliseconds;
		do {
			if (
				!signalGroup(0) &&
				(child.exitCode !== null || child.signalCode !== null)
			) {
				stoppedChildren.add(child);
				return true;
			}
			await delay(Math.min(25, Math.max(1, end - performance.now())));
		} while (performance.now() < end);
		return false;
	};
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		signalGroup(signal);
		if (await wait()) return;
	}
	throw new Error("The owned emulator process group did not exit");
}
