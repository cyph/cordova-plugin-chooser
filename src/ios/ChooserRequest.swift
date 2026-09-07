import Foundation

enum ChooserReadMode: String { case data, metadata, copy }
enum ChooserRequestState { case selecting, processing, completing, finished }

final class ChooserRequest {
	let callback: String
	let accept: String
	let mode: ChooserReadMode
	let multiple: Bool
	let limit: Int64
	let maxFiles: Int64
	let maxTotalSize: Int64
	let budget: ChooserBudget
	private let lock = NSLock()
	private var invalidated = false
	private var currentState = ChooserRequestState.selecting
	private var coordinator: NSFileCoordinator?
	private var resource: ChooserTransaction?

	init(callback: String, accept: String, mode: ChooserReadMode, multiple: Bool, limit: Int64, maxFiles: Int64 = 0, maxTotalSize: Int64 = 0) {
		self.callback = callback
		self.accept = accept
		self.mode = mode
		self.multiple = multiple
		self.limit = limit
		self.maxFiles = maxFiles
		self.maxTotalSize = maxTotalSize
		self.budget = ChooserBudget(fileLimit: limit, totalLimit: maxTotalSize)
	}
	var canceled: Bool {
		lock.lock(); defer { lock.unlock() }
		return invalidated
	}
	var state: ChooserRequestState {
		lock.lock(); defer { lock.unlock() }
		return currentState
	}
	func process() -> Bool {
		lock.lock(); defer { lock.unlock() }
		guard !invalidated, currentState == .selecting else { return false }
		currentState = .processing
		return true
	}
	func complete() -> Bool {
		lock.lock(); defer { lock.unlock() }
		guard !invalidated, currentState == .selecting || currentState == .processing else { return false }
		currentState = .completing
		return true
	}
	func finish() {
		lock.lock(); defer { lock.unlock() }
		currentState = .finished
	}
	var transaction: ChooserTransaction? {
		lock.lock(); defer { lock.unlock() }
		return resource
	}
	func attach(_ transaction: ChooserTransaction) {
		lock.lock(); defer { lock.unlock() }
		resource = transaction
	}
	func finishResources(delivered: Bool) {
		lock.lock()
		let value = resource
		resource = nil
		lock.unlock()
		if let transaction = value {
			ChooserTransaction.housekeeping.async { transaction.finish(delivered: delivered) }
		}
	}
	func coordinate(using value: NSFileCoordinator?) {
		lock.lock()
		coordinator = value
		let shouldCancel = invalidated
		lock.unlock()
		if shouldCancel { value?.cancel() }
	}
	func cancel() {
		lock.lock()
		invalidated = true
		currentState = .finished
		let value = coordinator
		lock.unlock()
		value?.cancel()
	}
	func checkCanceled() throws {
		if canceled { throw ChooserFailure(code: .readInterrupted, detail: "Request was reset.") }
	}
}
