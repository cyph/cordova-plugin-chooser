package com.cyph.cordova;

import java.io.IOException;

final class ChooserError extends IOException {
	enum Code {
		INVALID_ARGUMENT, BUSY, PICKER_FAILED, READ_FAILED, READ_INTERRUPTED,
		FILE_TOO_LARGE, TOO_MANY_FILES, TOTAL_SIZE_EXCEEDED, CACHE_FAILED,
		COPY_FAILED, RELEASE_FAILED, OUT_OF_MEMORY
	}
	final Code code;
	ChooserError(Code code, String detail) {
		super(message(code, detail));
		this.code = code;
	}
	static String message(Code code, String detail) { return code.name() + ": " + detail; }
}
