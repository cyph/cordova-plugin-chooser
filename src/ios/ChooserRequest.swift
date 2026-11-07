import Foundation

enum ChooserReadMode: String { case data, metadata, copy }
enum ChooserRequestState { case selecting, processing, completing, finished }

final class ChooserRequest {
	let callback: String
	let id: String
	let source: String
	let mediaTypes: [String]
	let accept: String
	let mode: ChooserReadMode
	let multiple: Bool
	let limit: Int64
	let maxFiles: Int64
	let maxTotalSize: Int64
	let budget: ChooserBudget
	let importBudget: ChooserBudget
	let worker: ChooserWork?
	private let lock = NSLock()
	private var invalidated = false
	private var interruption: String?
	private var progress: Progress?
	private var sources: [(ChooserResources, String)] = []
	private var cleanupFailed = false
	private var originalFailure: [String: Any]?
	private var failures: [[String: Any]] = []
	private var currentState = ChooserRequestState.selecting
	private var coordinator: NSFileCoordinator?
	private var resource: ChooserTransaction?

	init(callback: String, accept: String, mode: ChooserReadMode, multiple: Bool, limit: Int64, maxFiles: Int64 = 0, maxTotalSize: Int64 = 0, worker: ChooserWork? = nil, id: String? = nil, source: String = "documents", mediaTypes: [String] = ["image", "video"]) {
		self.id = id ?? callback
		self.source = source
		self.mediaTypes = mediaTypes
		self.worker = worker
		self.callback = callback
		self.accept = accept
		self.mode = mode
		self.multiple = multiple
		self.limit = limit
		self.maxFiles = maxFiles
		self.maxTotalSize = maxTotalSize
		self.budget = ChooserBudget(fileLimit: limit, totalLimit: maxTotalSize)
		self.importBudget = ChooserBudget(fileLimit: limit, totalLimit: maxTotalSize)
	}
	var canceled: Bool {
		lock.lock(); defer { lock.unlock() }
		return invalidated || interruption != nil
	}
	var state: ChooserRequestState {
		lock.lock(); defer { lock.unlock() }
		return currentState
	}
	func process() -> Bool {
		lock.lock(); defer { lock.unlock() }
		guard !invalidated, interruption == nil, currentState == .selecting else { return false }
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
		worker?.releaseIfIdle()
	}
	var transaction: ChooserTransaction? {
		lock.lock(); defer { lock.unlock() }
		return resource
	}
	func attach(_ transaction: ChooserTransaction) {
		lock.lock(); defer { lock.unlock() }
		resource = transaction
	}
	func trackSource(_ id: String, in store: ChooserResources) {
		lock.lock(); sources.append((store, id)); lock.unlock()
	}
	func finishResources(delivered: Bool, wait: Bool = false) {
		if wait {
			dispatchPrecondition(condition: .notOnQueue(ChooserTransaction.housekeeping))
			let finished = DispatchSemaphore(value: 0)
			finishResources(delivered: delivered) { finished.signal() }
			finished.wait()
		} else { finishResources(delivered: delivered, completion: {}) }
	}
	func finishResources(delivered: Bool, completion: @escaping () -> Void) {
		lock.lock()
		let value = resource
		let transient = sources
		resource = nil
		sources = []
		lock.unlock()
		let releases = DispatchGroup()
		if !delivered {
			for (store, id) in transient {
				releases.enter()
				store.release(id: id) { result in
					if case .failure(let error) = result { self.recordCleanup(error, ids: [id]) }
					releases.leave()
				}
			}
		}
		// Source releases must finish before rollback can unlink their imported
		// files. Notify schedules the transaction only after its own leases end.
		releases.notify(queue: ChooserTransaction.housekeeping, work: DispatchWorkItem {
			if let transaction = value {
				do { try transaction.finishChecked(delivered: delivered) }
				catch {
					if delivered { NSLog("Chooser cache journal cleanup incomplete; recovery retained.") }
					else { self.recordCleanup(error, ids: transaction.fileIDs) }
				}
			}
			completion()
		})
	}

	func recordFailure(_ error: Error) {
		let failure = error as? ChooserFailure
		lock.lock(); defer { lock.unlock() }
		if originalFailure == nil {
			originalFailure = ["code": (failure?.code ?? .readFailed).rawValue, "message": failure?.detail ?? error.localizedDescription]
		}
	}

	private func recordCleanup(_ error: Error, ids: [String]) {
		lock.lock(); defer { lock.unlock() }
		cleanupFailed = true
		for id in ids {
			failures.append(["id": id, "error": ["code": "RELEASE_FAILED", "message": error.localizedDescription]])
		}
	}
	var cleanupError: [String: Any]? {
		lock.lock(); defer { lock.unlock() }
		guard cleanupFailed else { return nil }
		let reason: [String: Any]
		if let cancellation = interruption {
			reason = ["code": "CANCELLED", "reason": cancellation, "message": "Selection canceled."]
		} else if invalidated {
			reason = ["code": "CANCELLED", "reason": "signal", "message": "Selection was reset."]
		} else {
			reason = originalFailure ?? ["code": "READ_FAILED", "message": "Selection result was not delivered."]
		}
		return ["code": "CLEANUP_FAILED", "message": "Selection cleanup failed; some resources may remain.",
			"outcome": ["status": "rejected", "reason": reason], "failures": failures]
	}

	var cancellationReason: String? {
		lock.lock(); defer { lock.unlock() }
		return interruption
	}
	func signalCancel(reason: String) {
		lock.lock()
		interruption = interruption ?? reason
		let coordination = coordinator
		let loading = progress
		lock.unlock()
		coordination?.cancel()
		loading?.cancel()
	}
	func loading(_ value: Progress?) {
		lock.lock(); progress = value; let stopped = invalidated || interruption != nil; lock.unlock()
		if stopped { value?.cancel() }
	}
	func coordinate(using value: NSFileCoordinator?) {
		lock.lock()
		coordinator = value
		let shouldCancel = invalidated || interruption != nil
		lock.unlock()
		if shouldCancel { value?.cancel() }
	}
	func cancel() {
		lock.lock()
		invalidated = true
		currentState = .finished
		let value = coordinator
		let loading = progress
		lock.unlock()
		value?.cancel()
		loading?.cancel()
		worker?.releaseIfIdle()
	}
	func checkCanceled() throws {
		if canceled { throw ChooserFailure(code: .readInterrupted, detail: "Request was reset.") }
	}
}
