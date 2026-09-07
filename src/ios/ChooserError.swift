import Foundation

enum ChooserErrorCode: String {
	case invalidArgument = "INVALID_ARGUMENT", busy = "BUSY", pickerFailed = "PICKER_FAILED"
	case readFailed = "READ_FAILED", readInterrupted = "READ_INTERRUPTED"
	case fileTooLarge = "FILE_TOO_LARGE", tooManyFiles = "TOO_MANY_FILES", totalSizeExceeded = "TOTAL_SIZE_EXCEEDED"
	case cacheFailed = "CACHE_FAILED", copyFailed = "COPY_FAILED", releaseFailed = "RELEASE_FAILED"
}

struct ChooserFailure: LocalizedError {
	let code: ChooserErrorCode
	let detail: String
	var message: String { return code.rawValue + ": " + detail }
	var errorDescription: String? { return message }
}
