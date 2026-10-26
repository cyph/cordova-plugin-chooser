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

export async function stopOwnedChild(child, milliseconds = 5_000) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
		return;
	const wait = () =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				child.off("exit", exited);
				resolve(false);
			}, milliseconds);
			function exited() {
				clearTimeout(timer);
				resolve(true);
			}
			child.once("exit", exited);
			if (child.exitCode !== null || child.signalCode !== null) exited();
		});
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if (error.code === "ESRCH") return;
			throw error;
		}
		if (await wait()) return;
	}
	throw new Error("The owned emulator process did not exit");
}
