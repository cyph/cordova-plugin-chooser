// Host-only Foundation fixtures; build instructions are in docs/VERIFICATION.md.
import Foundation

enum FixtureError: Error { case failed(String) }
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
	if !(try condition()) { throw FixtureError.failed(message) }
}
func rejects(_ message: String, _ action: () throws -> Void) throws {
	do { try action() }
	catch { return }
	throw FixtureError.failed(message)
}

final class MainReferenceFixture {
	#if compiler(>=5.9)
	@MainActor
	#endif
	var deliveries = 0
}

// Exercise the same opaque handoff used by legacy plugin/worker callbacks.
func scheduleMainProbe(_ completion: DispatchGroup, reference: ChooserMainReference<MainReferenceFixture>) {
	ChooserWork.dispatch(on: .global()) {
		ChooserMain.run {
			precondition(Thread.isMainThread, "background callback escaped the main queue")
			reference.value.deliveries += 1
			completion.leave()
		}
	}
}

// Reset and nested main-thread calls must finish before the caller continues.
do {
	var order: [Int] = []
	ChooserMain.run {
		order.append(1)
		ChooserMain.run { order.append(2) }
		order.append(3)
	}
	order.append(4)
	try require(order == [1, 2, 3, 4], "main dispatch lost synchronous reset ordering")
	ChooserMain.invokeLegacy { order.append(5) }
	try require(order == [1, 2, 3, 4, 5], "legacy actor bridge changed callback ordering")
	let completion = DispatchGroup()
	completion.enter()
	let reference = ChooserMainReference(MainReferenceFixture())
	scheduleMainProbe(completion, reference: reference)
	let deadline = Date().addingTimeInterval(5)
	while completion.wait(timeout: .now()) != .success && Date() < deadline {
		RunLoop.current.run(until: Date().addingTimeInterval(0.01))
	}
	try require(completion.wait(timeout: .now()) == .success, "background callback never reached main")
	ChooserMain.run {
		precondition(reference.value.deliveries == 1, "legacy reference handoff lost or repeated its callback")
	}
}

let manager = FileManager.default
let sandbox = manager.temporaryDirectory.appendingPathComponent("chooser-fixtures-" + UUID().uuidString)
try manager.createDirectory(at: sandbox, withIntermediateDirectories: true)
defer { try? manager.removeItem(at: sandbox) }

// Exact bytes across buffer boundaries; empty input and the zero/unlimited convention.
for size in [0, 1, 2, 3, 65535, 65536, 65537, 200003] {
	let bytes = Data((0..<size).map { UInt8($0 % 251) })
	let destination = try ChooserFiles.create(in: sandbox)
	let input = InputStream(data: bytes)
	let output = OutputStream(url: destination, append: false)!
	let count = try ChooserFiles.copy(input: input, output: output, limit: 0, canceled: { false })
	try require(count == Int64(size), "incorrect byte count")
	let copied = try Data(contentsOf: destination)
	try require(copied == bytes, "binary corruption at size \(size)")
	try require(input.streamStatus == .closed && output.streamStatus == .closed, "streams not closed")
	try ChooserFiles.release(in: sandbox, id: destination.lastPathComponent)
	try ChooserFiles.release(in: sandbox, id: destination.lastPathComponent)
}

// The limit uses bytes read, independent of any provider-reported metadata size.
let limited = try ChooserFiles.create(in: sandbox)
let limitedInput = InputStream(data: Data(repeating: 91, count: 65537))
let limitedOutput = OutputStream(url: limited, append: false)!
try rejects("over-limit input accepted") {
	_ = try ChooserFiles.copy(input: limitedInput, output: limitedOutput, limit: 65536, canceled: { false })
}
try require(limitedInput.streamStatus == .closed && limitedOutput.streamStatus == .closed, "error leaked streams")
let partial = try Data(contentsOf: limited)
try require(partial.count <= 65536, "wrote past limit")
try ChooserFiles.release(in: sandbox, id: limited.lastPathComponent)
let exactOutput = OutputStream.toMemory()
let exactCount = try ChooserFiles.copy(input: InputStream(data: Data([1, 2, 3])), output: exactOutput, limit: 3, canceled: { false })
try require(exactCount == 3, "exact limit rejected")

// Reset before and during a copy closes both streams and rejects the operation.
for cancelAfter in [0, 3] {
	var checks = 0
	let input = InputStream(data: Data(repeating: 3, count: 300000))
	let output = OutputStream.toMemory()
	try rejects("canceled copy completed") {
		_ = try ChooserFiles.copy(input: input, output: output, limit: 0, canceled: {
			checks += 1
			return checks > cancelAfter
		})
	}
	try require(input.streamStatus == .closed && output.streamStatus == .closed, "cancel leaked streams")
}

// Missing/offline input and a destination that cannot be opened must reject.
try rejects("missing source accepted") {
	_ = try ChooserFiles.copy(input: InputStream(url: sandbox.appendingPathComponent("missing"))!, output: OutputStream.toMemory(), limit: 0, canceled: { false })
}
try rejects("directory output accepted") {
	_ = try ChooserFiles.copy(input: InputStream(data: Data([1])), output: OutputStream(url: sandbox, append: false)!, limit: 0, canceled: { false })
}

// An ID never grants access outside the dedicated cache directory.
let source = sandbox.appendingPathComponent("source.txt")
try Data("original".utf8).write(to: source)
for bad in ["../source.txt", source.absoluteString, "", "00000000-0000-4000-8000-000000000000\n"] {
	try rejects("invalid id accepted") { try ChooserFiles.release(in: sandbox, id: bad) }
}
let root = try ChooserFiles.directory(in: sandbox)
let linkID = "00000000-0000-4000-8000-000000000000"
let link = root.appendingPathComponent(linkID)
try manager.createSymbolicLink(at: link, withDestinationURL: source)
try rejects("source symlink accepted") { try ChooserFiles.release(in: sandbox, id: linkID) }
let original = try Data(contentsOf: source)
try require(original == Data("original".utf8), "source was changed")
try manager.removeItem(at: link)
let directoryID = "00000000-0000-4000-8000-000000000001"
try manager.createDirectory(at: root.appendingPathComponent(directoryID), withIntermediateDirectories: false)
try rejects("directory release accepted") { try ChooserFiles.release(in: sandbox, id: directoryID) }
try manager.removeItem(at: root.appendingPathComponent(directoryID))
try manager.removeItem(at: root)
try manager.createSymbolicLink(at: root, withDestinationURL: sandbox)
try rejects("cache root symlink accepted") { _ = try ChooserFiles.create(in: sandbox) }

// Short writes must preserve bytes, while a stalled output must fail rather than loop.
class FixtureOutput: OutputStream {
	private var status: Stream.Status = .notOpen
	override var streamStatus: Stream.Status { status }
	override var streamError: Error? { nil }
	override var hasSpaceAvailable: Bool { status == .open }
	override func open() { status = .open }
	override func close() { status = .closed }
}
final class ShortOutput: FixtureOutput {
	var bytes = Data()
	override func write(_ buffer: UnsafePointer<UInt8>, maxLength len: Int) -> Int {
		guard hasSpaceAvailable else { return -1 }
		let count = min(len, 7)
		bytes.append(buffer, count: count)
		return count
	}
}
final class StalledOutput: FixtureOutput {
	override func write(_ buffer: UnsafePointer<UInt8>, maxLength len: Int) -> Int { return hasSpaceAvailable ? 0 : -1 }
}
let shortBytes = Data((0..<65539).map { UInt8($0 % 251) })
let shortOutput = ShortOutput.toMemory()
let shortCount = try ChooserFiles.copy(input: InputStream(data: shortBytes), output: shortOutput, limit: 0, canceled: { false })
try require(shortCount == Int64(shortBytes.count) && shortOutput.bytes == shortBytes, "short writes corrupted contents")
try require(shortOutput.streamStatus == .closed, "short-write output not closed")
let stalled = StalledOutput.toMemory()
try rejects("zero output write accepted") {
	_ = try ChooserFiles.copy(input: InputStream(data: Data([1])), output: stalled, limit: 0, canceled: { false })
}
try require(stalled.streamStatus == .closed, "failed output not closed")

// Aggregate exhaustion remains distinct from the zero/unlimited option.
let budget = ChooserBudget(fileLimit: 2, totalLimit: 3)
for bytes in [Data([1]), Data([2, 3]), Data()] {
	let count = try ChooserFiles.copy(input: InputStream(data: bytes), output: OutputStream.toMemory(), budget: budget, canceled: { false })
	try require(count == Int64(bytes.count), "exact aggregate limit rejected")
}
do {
	_ = try ChooserFiles.copy(input: InputStream(data: Data([4])), output: OutputStream.toMemory(), budget: budget, canceled: { false })
	throw FixtureError.failed("exhausted budget became unlimited")
}
catch let error as ChooserFailure { try require(error.code == .totalSizeExceeded, "wrong aggregate error") }
let unlimitedCount = try ChooserFiles.copy(input: InputStream(data: Data([1, 2, 3, 4])), output: OutputStream.toMemory(), budget: ChooserBudget(fileLimit: 0, totalLimit: 0), canceled: { false })
try require(unlimitedCount == 4, "budget leaked across requests")

func newCache() throws -> URL {
	let cache = sandbox.appendingPathComponent(UUID().uuidString)
	try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
	return cache
}
func staged(_ transaction: ChooserTransaction, _ value: UInt8) throws -> URL {
	let file = try transaction.create()
	try Data([value]).write(to: file)
	return file
}
func exists(_ file: URL) -> Bool { return FileManager.default.fileExists(atPath: file.path) }

// Recover committed bookkeeping without removing a reference that could have been delivered.
do {
	let cache = try newCache()
	let transaction = try ChooserTransaction(cache: cache)
	let source = try staged(transaction, 42)
	let destination = try transaction.destination(for: source)
	try require(!exists(destination), "staged file published before commit")
	try transaction.commit()
	try require(!exists(source) && exists(destination), "file not promoted")
	try ChooserTransaction.recover(in: cache)
	let bytes = try Data(contentsOf: destination)
	try require(bytes == Data([42]) && !exists(transaction.staging), "committed recovery removed reference")
	try ChooserFiles.release(in: cache, id: destination.lastPathComponent)
}

// Initialization recovers an abandoned staging directory exactly once per cache per process.
do {
	let cache = try newCache()
	let abandoned = try ChooserTransaction(cache: cache)
	_ = try staged(abandoned, 1)
	let active = try ChooserTransaction.begin(in: cache)
	try require(!exists(abandoned.staging), "unjournaled copy survived recovery")
	let source = try staged(active, 2)
	let another = try ChooserTransaction.begin(in: cache)
	try require(exists(source), "initialization swept an active request")
	active.finish(delivered: false)
	another.finish(delivered: false)
	try require(!exists(active.staging) && !exists(another.staging), "abandoned staging not removed")
}

// Stop between two promotions, then recover without an in-memory request object.
do {
	let cache = try newCache()
	var moves = 0
	let operations = ChooserTransaction.Operations(move: { from, to in
		moves += 1
		if moves == 2 { throw FixtureError.failed("injected promotion failure") }
		try manager.moveItem(at: from, to: to)
	}, remove: { try manager.removeItem(at: $0) })
	let transaction = try ChooserTransaction(cache: cache, operations: operations)
	let first = try staged(transaction, 1)
	let second = try staged(transaction, 2)
	let firstDestination = try transaction.destination(for: first)
	let secondDestination = try transaction.destination(for: second)
	try rejects("promotion failure ignored") { try transaction.commit() }
	try require(exists(firstDestination) && exists(second), "fixture did not stop between promotions")
	try ChooserTransaction.recover(in: cache)
	try require(!exists(firstDestination) && !exists(secondDestination) && !exists(transaction.staging), "partial promotion not rolled back")
}

// Deletion failure must retain the journal and still attempt the rest of the batch.
do {
	let cache = try newCache()
	var refuse: URL?
	let operations = ChooserTransaction.Operations(move: { try manager.moveItem(at: $0, to: $1) }, remove: { file in
		if file == refuse { throw FixtureError.failed("injected deletion failure") }
		try manager.removeItem(at: file)
	})
	let transaction = try ChooserTransaction(cache: cache, operations: operations)
	let first = try transaction.destination(for: staged(transaction, 1))
	let second = try transaction.destination(for: staged(transaction, 2))
	try transaction.commit()
	refuse = first
	transaction.finish(delivered: false)
	try require(exists(first) && !exists(second), "failed deletion skipped other copies")
	try require(exists(transaction.staging.appendingPathComponent("journal")), "retry journal lost")
	try ChooserTransaction.recover(in: cache)
	try require(!exists(first) && !exists(transaction.staging), "failed cleanup not recovered")
}

// Reset after the first rename stops subsequent promotions and rolls back the first.
do {
	var moves = 0
	let operations = ChooserTransaction.Operations(move: { from, to in
		try manager.moveItem(at: from, to: to)
		moves += 1
	}, remove: { try manager.removeItem(at: $0) })
	let transaction = try ChooserTransaction(cache: newCache(), operations: operations)
	let first = try transaction.destination(for: staged(transaction, 1))
	let second = try transaction.destination(for: staged(transaction, 2))
	do {
		try transaction.commit(canceled: { moves > 0 })
		throw FixtureError.failed("reset did not stop promotion")
	}
	catch let error as ChooserFailure { try require(error.code == .readInterrupted, "wrong reset error") }
	try require(moves == 1, "reset allowed further promotions")
	transaction.finish(delivered: false)
	try require(!exists(first) && !exists(second) && !exists(transaction.staging), "reset left promoted files")
}

// Dangling links cannot become journal output or releasable regular files.
do {
	let cache = try newCache()
	let transaction = try ChooserTransaction(cache: cache)
	let destination = try transaction.destination(for: staged(transaction, 1))
	let missing = cache.appendingPathComponent("must-not-create")
	try manager.createSymbolicLink(at: transaction.staging.appendingPathComponent("journal.tmp"), withDestinationURL: missing)
	try rejects("dangling journal link accepted") { try transaction.commit() }
	transaction.finish(delivered: false)
	try require(!exists(missing) && !exists(destination), "journal followed link or published data")
	let owned = try ChooserFiles.create(in: cache)
	try manager.removeItem(at: owned)
	try manager.createSymbolicLink(at: owned, withDestinationURL: missing)
	try rejects("dangling release link accepted") { try ChooserFiles.release(in: cache, id: owned.lastPathComponent) }
}

// Successful delivery is idempotent; a failed collision cannot claim an existing file.
do {
	let cache = try newCache()
	let delivered = try ChooserTransaction(cache: cache)
	let kept = try delivered.destination(for: staged(delivered, 1))
	try delivered.commit()
	delivered.finish(delivered: true)
	delivered.finish(delivered: false)
	try require(exists(kept) && !exists(delivered.staging), "duplicate cleanup removed delivered reference")
	let collision = try ChooserTransaction(cache: cache)
	let destination = try collision.destination(for: staged(collision, 2))
	try Data([99]).write(to: destination)
	try rejects("destination collision accepted") { try collision.commit() }
	collision.finish(delivered: false)
	let bytes = try Data(contentsOf: destination)
	try require(bytes == Data([99]), "collision removed another reference")
}

// Recovery rejects malformed IDs and symbolic links before removing target files.
do {
	let cache = try newCache()
	let foreign = cache.appendingPathComponent("source")
	try Data([99]).write(to: foreign)
	let malformed = try ChooserTransaction(cache: cache)
	try Data("chooser-1\npending\np:../../source\n".utf8).write(to: malformed.staging.appendingPathComponent("journal"))
	let linked = try ChooserTransaction(cache: cache)
	let destination = try linked.destination(for: staged(linked, 1))
	try linked.commit()
	try manager.removeItem(at: destination)
	try manager.createSymbolicLink(at: destination, withDestinationURL: foreign)
	try Data(("chooser-1\npending\np:" + destination.lastPathComponent + "\n").utf8).write(to: linked.staging.appendingPathComponent("journal"))
	try ChooserTransaction.recover(in: cache)
	let bytes = try Data(contentsOf: foreign)
	try require(bytes == Data([99]), "recovery changed source")
	try require(exists(malformed.staging) && exists(linked.staging), "invalid recovery discarded journal evidence")
}

// A request owns its coordinator, transitions and transaction, even across reset.
final class RecordingCoordinator: NSFileCoordinator {
	var canceledByRequest = false
	override func cancel() { canceledByRequest = true; super.cancel() }
}
do {
	let request = ChooserRequest(callback: "first", accept: "*/*", mode: .copy, multiple: false, limit: 0)
	try require(request.state == .selecting && request.process(), "request did not enter processing")
	try require(!request.process() && request.complete() && !request.complete(), "duplicate completion accepted")
	request.finish()
	try require(request.state == .finished, "request did not finish")
	let pending = ChooserRequest(callback: "second", accept: "*/*", mode: .copy, multiple: false, limit: 0)
	let coordinator = RecordingCoordinator(filePresenter: nil)
	pending.coordinate(using: coordinator)
	pending.cancel()
	try require(coordinator.canceledByRequest && !pending.process() && !pending.complete(), "reset retained callback ownership")
	let late = RecordingCoordinator(filePresenter: nil)
	pending.coordinate(using: late)
	try require(late.canceledByRequest, "late coordinator escaped reset")
	let transaction = try ChooserTransaction(cache: newCache())
	let destination = try transaction.destination(for: staged(transaction, 1))
	try transaction.commit()
	pending.attach(transaction)
	pending.finishResources(delivered: false)
	pending.finishResources(delivered: true)
	ChooserTransaction.housekeeping.sync {}
	try require(!exists(destination) && !exists(transaction.staging), "request did not roll back undelivered resources")
}

// Queued picker work must not turn an otherwise idle picker into BUSY.
do {
	let started = DispatchSemaphore(value: 0)
	let unblock = DispatchSemaphore(value: 0)
	let completed = DispatchSemaphore(value: 0)
	var workers: [ChooserWork] = []
	for _ in 0..<5 {
		guard let worker = ChooserWork.reserve() else { throw FixtureError.failed("queued worker unavailable") }
		workers.append(worker)
		worker.run { started.signal(); unblock.wait(); completed.signal() }
	}
	defer { for _ in 0..<5 { unblock.signal() } }
	for _ in 0..<4 { try require(started.wait(timeout: .now() + 5) == .success, "worker did not start") }
	try require(started.wait(timeout: .now() + 0.05) == .timedOut, "more than four request workers ran")
	unblock.signal()
	try require(started.wait(timeout: .now() + 5) == .success, "queued worker did not start after capacity returned")
	for _ in 0..<4 { unblock.signal() }
	for _ in 0..<5 { try require(completed.wait(timeout: .now() + 5) == .success, "worker never completed") }
	for worker in workers { worker.releaseIfIdle(); worker.releaseIfIdle() }
}

func decoded(_ value: [String: Any]) throws -> Data {
	guard let text = value["data"] as? String, let bytes = Data(base64Encoded: text) else { throw FixtureError.failed("invalid chunk base64") }
	try require(bytes.base64EncodedString() == text, "noncanonical chunk base64")
	return bytes
}

// Positional cache reads are independent, bounded, and work after registry recreation.
do {
	let cache = try newCache()
	let file = try ChooserFiles.create(in: cache)
	let id = file.lastPathComponent
	let bytes = Data((0..<300003).map { UInt8($0 % 251) })
	try bytes.write(to: file)
	let store = ChooserResources(cache: { cache })
	let stat = try store.stat(id: id)
	try require(stat["size"] as? Int64 == Int64(bytes.count), "stat trusted supplied metadata")
	for (offset, length) in [(200001, 17), (0, 262144), (300001, 7), (300003, 1), (400000, 9), (3, 0)] {
		let result = try store.read(id: id, offset: Int64(offset), length: length)
		let data = try decoded(result)
		let expected = offset < bytes.count ? Data(bytes.dropFirst(offset).prefix(length)) : Data()
		try require(data == expected, "positional read changed bytes")
		try require(result["eof"] as? Bool == (offset + data.count >= bytes.count), "incorrect positional EOF")
	}
	for (offset, length) in [(Int64(-1), 1), (Int64(0), 262145), (ChooserFiles.maxSafeInteger, 1)] {
		try rejects("invalid bounded range accepted") { _ = try store.read(id: id, offset: offset, length: length) }
	}
	try rejects("managed read canceled by another alias") { try store.cancelRead(id: id) }
	let restored = ChooserResources(cache: { cache })
	try require(try decoded(restored.read(id: id, offset: 0, length: 3)) == Data(bytes.prefix(3)), "restart lost cache access")
	try restored.release(id: id)
	try restored.release(id: id)
	try rejects("released cache file read") { _ = try store.read(id: id, offset: 0, length: 1) }
	try rejects("released cache file restored") { _ = try restored.stat(id: id) }
	let symbolic = try ChooserFiles.create(in: cache)
	try manager.removeItem(at: symbolic)
	try manager.createSymbolicLink(at: symbolic, withDestinationURL: source)
	try rejects("stat followed a symbolic link") { _ = try store.stat(id: symbolic.lastPathComponent) }
	try rejects("read followed a symbolic link") { _ = try store.read(id: symbolic.lastPathComponent, offset: 0, length: 1) }
}

final class StreamProbe {
	private let lock = NSLock()
	private var opens = 0
	private var closures = 0
	func opened() { lock.lock(); opens += 1; lock.unlock() }
	func closed() { lock.lock(); closures += 1; lock.unlock() }
	var counts: (Int, Int) { lock.lock(); defer { lock.unlock() }; return (opens, closures) }
}
class ProbedInput: InputStream {
	private let backing: InputStream
	private let probe: StreamProbe
	init(wrapping backing: InputStream, probe: StreamProbe) {
		self.backing = backing
		self.probe = probe
		// InputStream is a class cluster. Its initializer can initialize this
		// subclass, but the superclass's stream operations remain abstract.
		super.init(data: Data())
	}
	convenience init(data: Data, probe: StreamProbe) {
		self.init(wrapping: InputStream(data: data), probe: probe)
	}
	override var streamStatus: Stream.Status { backing.streamStatus }
	override var streamError: Error? { backing.streamError }
	override var hasBytesAvailable: Bool { backing.hasBytesAvailable }
	override func open() { probe.opened(); backing.open() }
	override func close() { backing.close(); probe.closed() }
	override func read(_ buffer: UnsafeMutablePointer<UInt8>, maxLength len: Int) -> Int {
		return backing.read(buffer, maxLength: len)
	}
	override func getBuffer(_ buffer: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, length len: UnsafeMutablePointer<Int>) -> Bool {
		return backing.getBuffer(buffer, length: len)
	}
}

// The adapter must preserve concrete Foundation stream behavior and probes.
for bytes in [Data(), Data([0, 128, 255])] {
	let probe = StreamProbe()
	let input = ProbedInput(data: bytes, probe: probe)
	try require(input.streamStatus == .notOpen && probe.counts.0 == 0, "adapter opened input eagerly")
	input.open()
	var buffer = [UInt8](repeating: 91, count: 8)
	let count = input.read(&buffer, maxLength: buffer.count)
	try require(count == bytes.count && Data(buffer.prefix(count)) == bytes, "adapter changed concrete stream bytes")
	try require(input.read(&buffer, maxLength: buffer.count) == 0, "adapter lost end-of-stream")
	try require(input.streamStatus == .atEnd && !input.hasBytesAvailable && input.streamError == nil, "adapter lost EOF status")
	input.close()
	try require(input.streamStatus == .closed && probe.counts.0 == 1 && probe.counts.1 == 1, "adapter lost open/close lifecycle")
}
do {
	let probe = StreamProbe()
	let missing = sandbox.appendingPathComponent("missing-probed-input")
	let backing = InputStream(url: missing)!
	let input = ProbedInput(wrapping: backing, probe: probe)
	input.open()
	var buffer = [UInt8](repeating: 0, count: 1)
	try require(input.read(&buffer, maxLength: 1) == -1, "adapter hid a concrete read failure")
	try require(input.streamStatus == .error && input.streamError != nil, "adapter lost error status")
	input.close()
	// Foundation can retain .error after close; lifecycle probes verify closure
	// independently while the adapter must preserve the concrete stream's status.
	try require(probe.counts.0 == 1 && probe.counts.1 == 1, "failed adapter did not complete exactly one open/close")
	try require(input.streamStatus == backing.streamStatus, "adapter changed the closed failed stream's status")
}

// A failed concrete input still takes the copy routine's two-stream cleanup path.
do {
	let probe = StreamProbe()
	let input = ProbedInput(wrapping: InputStream(url: sandbox.appendingPathComponent("missing-copy-input"))!, probe: probe)
	let output = OutputStream.toMemory()
	try rejects("failed probed input copied successfully") {
		_ = try ChooserFiles.copy(input: input, output: output, limit: 0, canceled: { false })
	}
	try require(probe.counts.0 == 1 && probe.counts.1 == 1, "copy failed to close its failed input exactly once")
	try require(output.streamStatus == .closed, "failed input left the copy output open")
}

// Sources are lazy, sequential, share actual-byte budgets, and cannot be restored.
do {
	let cache = try newCache()
	let url = cache.appendingPathComponent("provider.bin")
	try Data([1, 2, 3]).write(to: url)
	let probe = StreamProbe()
	let budget = ChooserBudget(fileLimit: 3, totalLimit: 4)
	let store = ChooserResources(cache: { cache })
	let first = try store.register(ChooserSource(url: url, budget: budget, makeStream: { _ in ProbedInput(data: Data([1, 2, 3]), probe: probe) }))
	let second = try store.register(ChooserSource(url: url, budget: budget))
	try require(probe.counts.0 == 0, "source selection loaded contents")
	try rejects("source restored as cache") { _ = try store.stat(id: first) }
	_ = try store.read(id: first, offset: 0, length: 0)
	try require(probe.counts.0 == 0, "zero-length read opened provider stream")
	try require(try decoded(store.read(id: first, offset: 0, length: 2)) == Data([1, 2]), "source chunk changed bytes")
	try rejects("source sought backwards") { _ = try store.read(id: first, offset: 0, length: 1) }
	let tail = try store.read(id: first, offset: 2, length: 2)
	try require(try decoded(tail) == Data([3]) && tail["eof"] as? Bool == true, "source short EOF incorrect")
	try require(probe.counts.0 == 1, "source reopened for each chunk")
	_ = try store.read(id: second, offset: 0, length: 1)
	do {
		_ = try store.read(id: second, offset: 1, length: 1)
		throw FixtureError.failed("batch source budget not enforced")
	} catch let error as ChooserFailure { try require(error.code == .totalSizeExceeded, "wrong source aggregate error") }
	try store.release(id: first)
	try store.release(id: second)
	try require(probe.counts.1 == 1 && exists(url), "release leaked stream or deleted provider original")
}

// A canceled source never opens lazily; release remains possible and idempotent.
do {
	let cache = try newCache()
	let url = cache.appendingPathComponent("provider.bin")
	try Data([1]).write(to: url)
	let probe = StreamProbe()
	let store = ChooserResources(cache: { cache })
	let id = try store.register(ChooserSource(url: url, budget: ChooserBudget(fileLimit: 0, totalLimit: 0), makeStream: { _ in ProbedInput(data: Data([1]), probe: probe) }))
	try store.cancelRead(id: UUID().uuidString.lowercased())
	try store.cancelRead(id: id)
	try rejects("canceled source opened") { _ = try store.read(id: id, offset: 0, length: 1) }
	try require(probe.counts.0 == 0, "cancelRead loaded content")
	try store.release(id: id)
	try store.cancelRead(id: id)
	try store.release(id: id)
	try require(exists(url), "cancelRead removed provider original")
}

final class BlockingInput: ProbedInput {
	let entered = DispatchSemaphore(value: 0)
	let resume = DispatchSemaphore(value: 0)
	init(probe: StreamProbe) { super.init(wrapping: InputStream(data: Data([42])), probe: probe) }
	override func read(_ buffer: UnsafeMutablePointer<UInt8>, maxLength len: Int) -> Int {
		entered.signal(); resume.wait()
		return super.read(buffer, maxLength: len)
	}
}

// Release waits for an actual blocked read, including after cancellation/reset.
do {
	let cache = try newCache()
	let imported = try ChooserFiles.create(in: cache)
	try Data([42]).write(to: imported)
	let probe = StreamProbe()
	let input = BlockingInput(probe: probe)
	let store = ChooserResources(cache: { cache })
	let id = try store.register(ChooserSource(url: imported, budget: ChooserBudget(fileLimit: 0, totalLimit: 0),
		cleanup: { try ChooserFiles.release(in: cache, id: imported.lastPathComponent) }, makeStream: { _ in input }))
	let readDone = DispatchSemaphore(value: 0)
	let released = DispatchSemaphore(value: 0)
	ChooserWork.dispatch(on: .global()) { _ = try? store.read(id: id, offset: 0, length: 1); readDone.signal() }
	defer { input.resume.signal() }
	try require(input.entered.wait(timeout: .now() + 5) == .success, "blocking source did not start")
	try store.cancelRead(id: id)
	try store.prepareRelease(id: id)
	ChooserWork.dispatch(on: .global()) { try? store.release(id: id); released.signal() }
	try require(released.wait(timeout: .now() + 0.05) == .timedOut, "release completed during actual I/O")
	try require(exists(imported) && probe.counts.1 == 0, "release deleted or closed an in-flight stream")
	input.resume.signal()
	try require(readDone.wait(timeout: .now() + 5) == .success, "read did not finish")
	try require(released.wait(timeout: .now() + 5) == .success, "release did not finish after read")
	try require(!exists(imported) && probe.counts.1 == 1, "release failed to clean imported source")
}

// Reset leaves blocked cleanup on its entry, not on shared housekeeping.
do {
	let cache = try newCache()
	let imported = try ChooserFiles.create(in: cache)
	let other = try ChooserFiles.create(in: cache)
	try Data([42]).write(to: imported)
	let probe = StreamProbe()
	let input = BlockingInput(probe: probe)
	let store = ChooserResources(cache: { cache })
	let id = try store.register(ChooserSource(url: imported, budget: ChooserBudget(fileLimit: 0, totalLimit: 0),
		cleanup: { try ChooserFiles.release(in: cache, id: imported.lastPathComponent) }, makeStream: { _ in input }))
	let readDone = DispatchSemaphore(value: 0)
	let sourceReleased = DispatchSemaphore(value: 0)
	let otherReleased = DispatchSemaphore(value: 0)
	let pickerCanceled = DispatchSemaphore(value: 0)
	let housekeepingAvailable = DispatchSemaphore(value: 0)
	var releaseResult: Result<Void, Error>?
	ChooserWork.dispatch(on: .global()) { _ = try? store.read(id: id, offset: 0, length: 1); readDone.signal() }
	defer { input.resume.signal() }
	try require(input.entered.wait(timeout: .now() + 5) == .success, "reset fixture read did not start")
	store.resetSources()
	store.release(id: id) { _ in sourceReleased.signal() }
	store.release(id: other.lastPathComponent) { result in releaseResult = result; otherReleased.signal() }
	let request = ChooserRequest(callback: "unrelated-picker", accept: "*/*", mode: .copy, multiple: false, limit: 0)
	request.signalCancel(reason: "picker")
	try require(request.complete(), "unrelated cancellation lost completion ownership")
	request.finishResources(delivered: false) { request.finish(); pickerCanceled.signal() }
	ChooserWork.dispatch(on: ChooserTransaction.housekeeping) { housekeepingAvailable.signal() }
	try require(otherReleased.wait(timeout: .now() + 5) == .success, "blocked source stalled unrelated release")
	try releaseResult!.get()
	try require(pickerCanceled.wait(timeout: .now() + 5) == .success && request.state == .finished, "blocked source stalled picker cancellation")
	try require(housekeepingAvailable.wait(timeout: .now() + 5) == .success, "blocked source occupied housekeeping")
	try require(!exists(other), "unrelated managed file was not released")
	try require(sourceReleased.wait(timeout: .now() + 0.05) == .timedOut, "blocked source released before its lease ended")
	try require(exists(imported) && probe.counts.1 == 0, "reset deleted or closed an in-flight source")
	input.resume.signal()
	try require(readDone.wait(timeout: .now() + 5) == .success, "reset source read never returned")
	try require(sourceReleased.wait(timeout: .now() + 5) == .success, "last read lease did not schedule cleanup")
	try require(!exists(imported) && probe.counts.1 == 1, "reset source was not cleaned exactly once")
}

// Failed reads retain their stream until release; cleanup retries never close it twice.
do {
	let cache = try newCache()
	let url = cache.appendingPathComponent("provider.bin")
	try Data([1]).write(to: url)
	let probe = StreamProbe()
	let store = ChooserResources(cache: { cache })
	var attempts = 0
	let id = try store.register(ChooserSource(url: url, budget: ChooserBudget(fileLimit: 0, totalLimit: 0), cleanup: {
		attempts += 1
		if attempts == 1 { throw FixtureError.failed("injected cleanup failure") }
	}, makeStream: { _ in
		ProbedInput(wrapping: InputStream(url: cache.appendingPathComponent("missing-source-input"))!, probe: probe)
	}))
	try rejects("source open failure accepted") { _ = try store.read(id: id, offset: 0, length: 1) }
	try rejects("failed source retried its stream") { _ = try store.read(id: id, offset: 0, length: 1) }
	try require(probe.counts.0 == 1 && probe.counts.1 == 0, "failed source reopened or closed before release")
	try rejects("cleanup failure ignored") { try store.release(id: id) }
	try require(probe.counts.1 == 1, "failed source cleanup did not close its stream")
	try rejects("failed release reopened resource") { _ = try store.read(id: id, offset: 0, length: 1) }
	try store.release(id: id)
	try store.release(id: id)
	try require(attempts == 2, "cleanup not retried")
	try require(probe.counts.0 == 1 && probe.counts.1 == 1, "cleanup retry reopened or closed the stream twice")
	// Reset invalidates sources without removing provider originals or managed copies.
	let owned = try ChooserFiles.create(in: cache)
	_ = try store.stat(id: owned.lastPathComponent)
	let transient = try store.register(ChooserSource(url: url, budget: ChooserBudget(fileLimit: 0, totalLimit: 0)))
	store.resetSources()
	try store.release(id: transient)
	try rejects("reset source remains readable") { _ = try store.read(id: transient, offset: 0, length: 1) }
	try require(exists(url) && exists(owned), "reset removed originals or managed copies")
}

// Signal cancellation preserves completion ownership; reset revokes it.
do {
	let request = ChooserRequest(callback: "signal", accept: "*/*", mode: .data, multiple: false, limit: 0, id: "identity")
	let progress = Progress(totalUnitCount: 1)
	request.loading(progress)
	request.signalCancel(reason: "signal")
	request.signalCancel(reason: "picker")
	try require(progress.isCancelled && request.cancellationReason == "signal", "signal did not cancel provider progress")
	try require(!request.process() && request.complete(), "signal lost terminal callback ownership")
	try require(!request.complete(), "cancellation completed twice")
	request.finish()
	let reset = ChooserRequest(callback: "reset", accept: "*/*", mode: .data, multiple: false, limit: 0)
	reset.cancel()
	let late = Progress(totalUnitCount: 1)
	reset.loading(late)
	try require(late.isCancelled && !reset.complete(), "late provider progress survived reset")
}

// Cancellation reports cleanup failures instead of quietly discarding them.
do {
	let cache = try newCache()
	let transaction = try ChooserTransaction(cache: cache, operations: .init(move: { try manager.moveItem(at: $0, to: $1) }, remove: { _ in
		throw FixtureError.failed("injected rollback deletion failure")
	}))
	_ = try staged(transaction, 1)
	let request = ChooserRequest(callback: "cleanup", accept: "*/*", mode: .copy, multiple: false, limit: 0)
	request.attach(transaction)
	request.signalCancel(reason: "signal")
	request.finishResources(delivered: false, wait: true)
	try require(request.cleanupError?["code"] as? String == "CLEANUP_FAILED", "cancellation swallowed cleanup failure")
	let outcome = request.cleanupError?["outcome"] as? [String: Any]
	let reason = outcome?["reason"] as? [String: Any]
	try require(outcome?["status"] as? String == "rejected" && reason?["code"] as? String == "CANCELLED" && reason?["reason"] as? String == "signal", "cleanup error lost cancellation outcome")
	try require((request.cleanupError?["failures"] as? [[String: Any]])?.count == 1, "cleanup failure lost resource identity")
	try ChooserTransaction.recover(in: cache)
	try require(!exists(transaction.staging), "failed cancellation cleanup was not recoverable")
}

// A failed batch retains its original failure when rollback also fails.
do {
	let cache = try newCache()
	let transaction = try ChooserTransaction(cache: cache, operations: .init(move: { try manager.moveItem(at: $0, to: $1) }, remove: { _ in
		throw FixtureError.failed("injected rollback failure")
	}))
	_ = try staged(transaction, 1)
	let request = ChooserRequest(callback: "failed-batch", accept: "*/*", mode: .copy, multiple: true, limit: 2)
	request.attach(transaction)
	request.recordFailure(ChooserFailure(code: .fileTooLarge, detail: "Original per-file limit failure."))
	request.finishResources(delivered: false, wait: true)
	let cleanup = request.cleanupError
	let outcome = cleanup?["outcome"] as? [String: Any]
	let reason = outcome?["reason"] as? [String: Any]
	try require(cleanup?["code"] as? String == "CLEANUP_FAILED", "rollback failure was not reported")
	try require(outcome?["status"] as? String == "rejected", "cleanup error omitted rejected outcome")
	try require(reason?["code"] as? String == "FILE_TOO_LARGE", "cleanup error replaced the original failure")
	try require(reason?["message"] as? String == "Original per-file limit failure.", "cleanup error lost original detail")
	try require((cleanup?["failures"] as? [[String: Any]])?.count == 1, "cleanup error lost failed resource identity")
	try ChooserTransaction.recover(in: cache)
}

print("Chooser Foundation fixtures completed")
