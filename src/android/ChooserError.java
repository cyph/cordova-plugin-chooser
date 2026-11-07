package com.cyph.cordova;

import java.io.IOException;

final class ChooserError extends IOException {
	private static final long serialVersionUID = 1L;
	enum Code {
		INVALID_ARGUMENT, BUSY, CANCELLED, PICKER_FAILED, READ_FAILED, READ_INTERRUPTED,
		FILE_UNAVAILABLE, FILE_RELEASED, PERMISSION_DENIED, CLEANUP_FAILED,
		FILE_TOO_LARGE, TOO_MANY_FILES, TOTAL_SIZE_EXCEEDED, CACHE_FAILED,
		COPY_FAILED, RELEASE_FAILED, OUT_OF_MEMORY
	}
	final Code code;
	final String detail;
	ChooserError(Code code, String detail) {
		super(message(code, detail));
		this.code = code;
		this.detail = detail;
	}
	static String message(Code code, String detail) { return code.name() + ": " + detail; }
}
