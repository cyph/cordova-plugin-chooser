package com.cyph.cordova;

/** One request's aggregate budget; used only by its sequential file worker. */
final class ChooserBudget {
	private final long fileLimit;
	private final long totalLimit;
	private long consumed;
	ChooserBudget(long fileLimit, long totalLimit) {
		this.fileLimit = fileLimit;
		this.totalLimit = totalLimit;
	}
	void consume(long fileBytes, int count) throws ChooserError {
		if (fileBytes > ChooserFiles.MAX_SAFE_INTEGER - count || (fileLimit > 0 && count > fileLimit - fileBytes)) {
			throw new ChooserError(ChooserError.Code.FILE_TOO_LARGE, "Selected file exceeds the byte limit.");
		}
		if (totalLimit > 0) {
			if (count > totalLimit - consumed) {
				throw new ChooserError(ChooserError.Code.TOTAL_SIZE_EXCEEDED, "Selection exceeds the total byte limit.");
			}
			consumed += count;
		}
	}
}
