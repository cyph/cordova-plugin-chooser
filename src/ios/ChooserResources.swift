import Foundation

/** A lazy provider stream retains its security scope until release. */
final class ChooserSource {
	private let url: URL
	private let budget: ChooserBudget
	private let makeStream: (URL) throws -> InputStream
	private let cleanup: () throws -> Void
	private let io = NSLock()
	private let cancellation = NSLock()
	private var interruption: ChooserErrorCode?
	private var coordinator: NSFileCoordinator?
	private var stream: InputStream?
	private var scoped = false
	private var closed = false
	private var position: Int64 = 0
	private var ended = false
	private var failure: Error?

	init(url: URL, budget: ChooserBudget, cleanup: @escaping () throws -> Void = {}, makeStream: @escaping (URL) throws -> InputStream = { url in
		guard let stream = InputStream(url: url) else { throw ChooserFailure(code: .readFailed, detail: "Cannot open selected file.") }
		return stream
	}) {
		self.url = url
		self.budget = budget
		self.cleanup = cleanup
		self.makeStream = makeStream
	}

	func interrupt(code: ChooserErrorCode = .fileReleased) {
		cancellation.lock()
		interruption = interruption ?? code
		let value = coordinator
		cancellation.unlock()
		value?.cancel()
	}

	private func check() throws {
		cancellation.lock(); defer { cancellation.unlock() }
		if let code = interruption { throw ChooserFailure(code: code, detail: "The source read was canceled or released.") }
	}

	func read(offset: Int64, length: Int) throws -> [String: Any] {
		io.lock(); defer { io.unlock() }
		try check()
		guard !closed else { throw ChooserFailure(code: .fileReleased, detail: "The source was released.") }
		guard offset == position else { throw ChooserFailure(code: .invalidArgument, detail: "Source reads must be sequential.") }
		if let error = failure { throw error }
		if length == 0 || ended { return ["data": "", "eof": ended] }
		if stream == nil { scoped = url.startAccessingSecurityScopedResource() }
		let value = NSFileCoordinator()
		cancellation.lock(); coordinator = value; let stopped = interruption != nil; cancellation.unlock()
		if stopped { value.cancel() }
		defer { cancellation.lock(); coordinator = nil; cancellation.unlock() }
		var coordinationError: NSError?
		var readError: Error?
		var bytes = Data()
		value.coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
			do {
				try check()
				if stream == nil {
					guard try coordinated.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
						throw ChooserFailure(code: .readFailed, detail: "Select a regular file.")
					}
					let input = try makeStream(coordinated)
					stream = input
					input.open()
				}
				guard let input = stream else { throw ChooserFailure(code: .readFailed, detail: "Cannot open selected file.") }
				var buffer = [UInt8](repeating: 0, count: min(length, 64 * 1024))
				while bytes.count < length {
					try check()
					let count = input.read(&buffer, maxLength: min(buffer.count, length - bytes.count))
					if count < 0 { throw input.streamError ?? ChooserFailure(code: .readFailed, detail: "Cannot read selected file.") }
					if count == 0 { ended = true; break }
					try budget.consume(fileBytes: position, count: count)
					position += Int64(count)
					bytes.append(contentsOf: buffer.prefix(count))
				}
			}
			catch { readError = error }
		}
		if let error = readError ?? coordinationError { failure = error; throw error }
		return ["data": bytes.base64EncodedString(), "eof": ended]
	}

	func close() throws {
		io.lock(); defer { io.unlock() }
		if !closed {
			closed = true
			stream?.close()
			stream = nil
			if scoped { url.stopAccessingSecurityScopedResource(); scoped = false }
		}
		// Retrying cleanup is safe even after the stream and scope were closed.
		try cleanup()
	}
}

/** Actual native I/O leases; deletion waits even if the JS caller has gone away. */
final class ChooserResources {
	private final class Entry {
		let id: String
		var source: ChooserSource?
		let transient: Bool
		var leases = 0
		var releasing = false
		var released = false
		var cleanupScheduled = false
		var completions: [(Result<Void, Error>) -> Void] = []
		init(id: String, source: ChooserSource? = nil) { self.id = id; self.source = source; self.transient = source != nil }
	}
	private let condition = NSLock()
	private var entries: [String: Entry] = [:]
	private let cache: () throws -> URL
	private let reads: OperationQueue = {
		let queue = OperationQueue()
		queue.name = "com.cyph.cordova.chooser.reads"
		queue.qualityOfService = .userInitiated
		queue.maxConcurrentOperationCount = 4
		return queue
	}()

	private let cleanups: OperationQueue = {
		let queue = OperationQueue()
		queue.name = "com.cyph.cordova.chooser.releases"
		queue.qualityOfService = .utility
		queue.maxConcurrentOperationCount = 4
		return queue
	}()

	init(cache: @escaping () throws -> URL) { self.cache = cache }

	func enqueue(_ action: @escaping () -> Void) {
		ChooserWork.enqueue(on: reads, action)
	}

	func register(_ source: ChooserSource, id: String = UUID().uuidString.lowercased()) throws -> String {
		try validate(id)
		condition.lock(); defer { condition.unlock() }
		guard entries[id] == nil else { throw ChooserFailure(code: .cacheFailed, detail: "Resource identity collision.") }
		entries[id] = Entry(id: id, source: source)
		return id
	}

	private func validate(_ id: String) throws {
		guard ChooserFiles.isID(id) else { throw ChooserFailure(code: .invalidArgument, detail: "Expected a managed file id.") }
	}

	private func acquire(_ id: String, managedOnly: Bool = false) throws -> Entry {
		try validate(id)
		condition.lock(); defer { condition.unlock() }
		let entry = entries[id] ?? Entry(id: id)
		entries[id] = entry
		guard !entry.releasing, !entry.released else {
			throw ChooserFailure(code: managedOnly ? .fileUnavailable : .fileReleased, detail: "The file was released.")
		}
		guard !managedOnly || !entry.transient else {
			throw ChooserFailure(code: .fileUnavailable, detail: "A transient source cannot be restored.")
		}
		entry.leases += 1
		return entry
	}

	private func relinquish(_ entry: Entry) {
		condition.lock()
		entry.leases -= 1
		let ready = readyForCleanup(entry)
		condition.unlock()
		if ready { scheduleCleanup(entry) }
	}

	func read(id: String, offset: Int64, length: Int) throws -> [String: Any] {
		guard offset >= 0, offset <= ChooserFiles.maxSafeInteger, length >= 0, length <= 262144,
			offset <= ChooserFiles.maxSafeInteger - Int64(length) else {
			throw ChooserFailure(code: .invalidArgument, detail: "Invalid bounded read range.")
		}
		let entry = try acquire(id)
		defer { relinquish(entry) }
		if let source = entry.source { return try source.read(offset: offset, length: length) }
		return try ChooserFiles.read(in: cache(), id: id, offset: offset, length: length)
	}

	func stat(id: String) throws -> [String: Any] {
		let entry = try acquire(id, managedOnly: true)
		defer { relinquish(entry) }
		return try ChooserFiles.stat(in: cache(), id: id)
	}

	// Called synchronously when release/reset reaches the bridge, before queued reads.
	func prepareRelease(id: String) throws {
		try validate(id)
		condition.lock()
		let entry = entries[id] ?? Entry(id: id)
		entries[id] = entry
		entry.releasing = true
		let source = entry.source
		condition.unlock()
		source?.interrupt()
	}

	// Caller holds condition. Waiting for a lease never occupies a cleanup worker.
	private func readyForCleanup(_ entry: Entry) -> Bool {
		guard entry.releasing, !entry.released, !entry.cleanupScheduled,
			entry.leases == 0, !entry.completions.isEmpty else { return false }
		entry.cleanupScheduled = true
		return true
	}

	private func scheduleCleanup(_ entry: Entry) {
		ChooserWork.enqueue(on: cleanups) {
			let result = Result { () throws -> Void in
				if let source = entry.source { try source.close() }
				else { try ChooserFiles.release(in: self.cache(), id: entry.id) }
			}
			self.condition.lock()
			if case .success = result { entry.released = true; entry.source = nil }
			entry.cleanupScheduled = false
			let callbacks = entry.completions
			entry.completions = []
			self.condition.unlock()
			// Complete outside the registry lock. A failed attempt can be retried;
			// successful entries retain neither provider objects nor callbacks.
			for callback in callbacks { callback(result) }
		}
	}

	func release(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
		do { try prepareRelease(id: id) }
		catch { completion(.failure(error)); return }
		condition.lock()
		let entry = entries[id]!
		if entry.released { condition.unlock(); completion(.success(())); return }
		entry.completions.append(completion)
		let ready = readyForCleanup(entry)
		condition.unlock()
		if ready { scheduleCleanup(entry) }
	}

	// Synchronous helper for callers already on their own worker. Production
	// release/reset callbacks use the asynchronous overload, never housekeeping.
	func release(id: String) throws {
		dispatchPrecondition(condition: .notOnQueue(ChooserTransaction.housekeeping))
		let finished = DispatchSemaphore(value: 0)
		var outcome: Result<Void, Error>?
		release(id: id) { result in outcome = result; finished.signal() }
		finished.wait()
		try outcome!.get()
	}

	func cancelRead(id: String) throws {
		try validate(id)
		condition.lock()
		let entry = entries[id]
		let source = entry?.source
		let transient = entry?.transient
		condition.unlock()
		if transient == false {
			throw ChooserFailure(code: .invalidArgument, detail: "Only a transient source read can be canceled by id.")
		}
		if entry == nil {
			// Missing source identities may already have been discarded by reset.
			// Existing RC1 cache files still must not acquire ID-wide cancellation.
			do { _ = try ChooserFiles.stat(in: cache(), id: id) }
			catch let error as ChooserFailure where error.code == .fileUnavailable { return }
			throw ChooserFailure(code: .invalidArgument, detail: "Only a transient source read can be canceled by id.")
		}
		// Cancellation never deletes a file or closes a descriptor being read.
		source?.interrupt(code: .cancelled)
	}

	func resetSources() {
		condition.lock()
		let ids = entries.compactMap { id, entry -> String? in
			guard entry.transient, !entry.released else { return nil }
			entry.releasing = true
			return id
		}
		condition.unlock()
		for id in ids {
			release(id: id) { result in
				if case .failure = result { NSLog("Chooser transient source cleanup incomplete; release may be retried.") }
			}
		}
	}
}
