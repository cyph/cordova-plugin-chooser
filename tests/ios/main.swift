// Host-only Foundation fixtures; build instructions are in docs/VERIFICATION.md.
import Foundation

enum FixtureError: Error { case failed(String) }
func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
	if !condition() { throw FixtureError.failed(message) }
}
func rejects(_ message: String, _ action: () throws -> Void) throws {
	do { try action() }
	catch { return }
	throw FixtureError.failed(message)
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
final class ShortOutput: OutputStream {
	var bytes = Data()
	override func write(_ buffer: UnsafePointer<UInt8>, maxLength len: Int) -> Int {
		let count = min(len, 7)
		bytes.append(buffer, count: count)
		return count
	}
}
final class StalledOutput: OutputStream {
	override func write(_ buffer: UnsafePointer<UInt8>, maxLength len: Int) -> Int { return 0 }
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
	try manager.createDirectory(at: cache, withIntermediateDirectories: true)
	return cache
}
func staged(_ transaction: ChooserTransaction, _ value: UInt8) throws -> URL {
	let file = try transaction.create()
	try Data([value]).write(to: file)
	return file
}
func exists(_ file: URL) -> Bool { return manager.fileExists(atPath: file.path) }

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

print("Chooser Foundation fixtures completed")
