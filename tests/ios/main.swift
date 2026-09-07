// Host-only Foundation fixtures. Compile with the production ChooserFiles.swift on macOS.
// This file has been written and statically reviewed; execution is deferred.
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

print("Chooser Foundation fixtures completed")
