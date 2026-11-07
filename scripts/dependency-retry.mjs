const transient =
	/(?:\bHTTP(?:\/\S+)?\s*(?:error|status(?: code)?)?\s*[:=]?\s*(?:429|502|503|504)\b|status code (?:429|502|503|504)\b|Connection reset|Temporary failure in name resolution|Read timed out|Connect timed out)/i;
const permanent =
	/(?:checksum|dependency verification failed|verification metadata|changed artifact|lock state|dependency lock|test(?:s)? (?:failed|failure)|assertion|BUILD SUCCESSFUL)/i;

export function retryDependencyPreparation(
	operation,
	{
		now = Date.now,
		wait = (milliseconds) =>
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				milliseconds,
			),
		budgetMs = 1200000,
	} = {},
) {
	const deadline = now() + budgetMs;
	for (let attempt = 0; ; attempt++) {
		try {
			return operation(Math.max(1, deadline - now()), attempt + 1);
		} catch (error) {
			const output = error.commandOutput || "";
			const delay = [15000, 45000][attempt];
			if (
				delay === undefined ||
				permanent.test(output) ||
				!transient.test(output) ||
				now() + delay >= deadline
			)
				throw error;
			wait(delay);
		}
	}
}
