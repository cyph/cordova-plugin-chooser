import Foundation

/** Shared by lazy sources in one selection; every consumption is atomic. */
final class ChooserBudget {
	private let fileLimit: Int64
	private let totalLimit: Int64
	private var consumed: Int64 = 0
	private let lock = NSLock()
	init(fileLimit: Int64, totalLimit: Int64) {
		self.fileLimit = fileLimit
		self.totalLimit = totalLimit
	}
	func consume(fileBytes: Int64, count: Int) throws {
		lock.lock(); defer { lock.unlock() }
		guard count >= 0, fileBytes >= 0 else { throw ChooserFailure(code: .invalidArgument, detail: "Invalid byte count.") }
		let bytes = Int64(count)
		if fileBytes > ChooserFiles.maxSafeInteger - bytes || (fileLimit > 0 && bytes > fileLimit - fileBytes) {
			throw ChooserFailure(code: .fileTooLarge, detail: "Selected file exceeds the byte limit.")
		}
		if totalLimit > 0 {
			if bytes > totalLimit - consumed {
				throw ChooserFailure(code: .totalSizeExceeded, detail: "Selection exceeds the total byte limit.")
			}
			consumed += bytes
		}
	}
}
