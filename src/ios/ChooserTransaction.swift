import Foundation
import Darwin

final class ChooserTransaction {
	static let housekeeping = DispatchQueue(label: "com.cyph.cordova.chooser.cache", qos: .utility)
	private static let initialization = NSLock()
	private static var initialized = Set<String>()
	struct Operations {
		var move: (URL, URL) throws -> Void
		var remove: (URL) throws -> Void
		static let files = Operations(move: { from, to in
			try FileManager.default.moveItem(at: from, to: to)
		}, remove: { try FileManager.default.removeItem(at: $0) })
	}
	private struct Entry {
		let id: String
		var promoting: Bool
	}
	private let root: URL
	let staging: URL
	private let operations: Operations
	private var entries: [Entry] = []
	private var committed = false
	private var settled = false

	static func begin(in cache: URL) throws -> ChooserTransaction {
		initialization.lock(); defer { initialization.unlock() }
		let root = try ChooserFiles.directory(in: cache)
		if !initialized.contains(root.path) {
			try recover(in: cache)
			initialized.insert(root.path)
		}
		return try ChooserTransaction(cache: cache)
	}

	init(cache: URL, operations: Operations = .files) throws {
		self.root = try ChooserFiles.directory(in: cache)
		self.operations = operations
		let parent = try Self.directory(root.appendingPathComponent(".pending", isDirectory: true))
		var allocated: URL?
		for _ in 0..<10 {
			let candidate = parent.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
			if candidate.path.withCString({ Darwin.mkdir($0, mode_t(0o700)) }) == 0 {
				allocated = candidate
				break
			}
			if errno != EEXIST { throw Self.failure() }
		}
		guard let folder = allocated else { throw Self.failure() }
		staging = folder
	}

	func create() throws -> URL {
		guard !committed, !settled else { throw Self.failure() }
		let file = try ChooserFiles.createFile(in: staging)
		guard !FileManager.default.fileExists(atPath: root.appendingPathComponent(file.lastPathComponent).path) else {
			try operations.remove(file)
			throw Self.failure()
		}
		entries.append(Entry(id: file.lastPathComponent, promoting: false))
		return file
	}

	func destination(for file: URL) throws -> URL {
		guard file.deletingLastPathComponent().standardizedFileURL.path == staging.standardizedFileURL.path,
			ChooserFiles.isID(file.lastPathComponent) else { throw Self.failure() }
		return root.appendingPathComponent(file.lastPathComponent)
	}

	func commit() throws {
		guard !committed, !settled else { throw Self.failure() }
		for index in entries.indices {
			let source = staging.appendingPathComponent(entries[index].id)
			let target = root.appendingPathComponent(entries[index].id)
			try Self.regular(source)
			try Self.canonical(target)
			guard !FileManager.default.fileExists(atPath: target.path) else { throw Self.failure() }
			entries[index].promoting = true
		}
		try save(committed: false)
		for entry in entries {
			try operations.move(staging.appendingPathComponent(entry.id), root.appendingPathComponent(entry.id))
		}
		try save(committed: true)
		committed = true
	}

	func finish(delivered: Bool) {
		guard !settled else { return }
		settled = true
		if !delivered || !committed {
			do { try save(committed: false) }
			catch { Self.diagnostic() }
			do { try Self.rollback(root: root, folder: staging, entries: entries, operations: operations) }
			catch { Self.diagnostic(); return }
		}
		do { try Self.removeStaging(staging, operations: operations) }
		catch { Self.diagnostic() }
	}

	private func save(committed: Bool) throws {
		let journal = "chooser-1\n" + (committed ? "committed\n" : "pending\n") +
			entries.map { ($0.promoting ? "p:" : "s:") + $0.id + "\n" }.joined()
		let file = staging.appendingPathComponent("journal")
		let temp = staging.appendingPathComponent("journal.tmp")
		try Self.canonical(file)
		try Self.canonical(temp)
		if FileManager.default.fileExists(atPath: file.path) { try Self.regular(file) }
		if FileManager.default.fileExists(atPath: temp.path) { try Self.regular(temp) }
		try Data(journal.utf8).write(to: temp)
		// A fixed temporary name is recoverable even if the process dies during a write.
		let result = temp.path.withCString { from in file.path.withCString { to in Darwin.rename(from, to) } }
		guard result == 0 else { throw Self.failure() }
	}

	/** Call before starting transactions, never while another process is writing this cache. */
	static func recover(in cache: URL, operations: Operations = .files) throws {
		let root = try ChooserFiles.directory(in: cache)
		let parent = try directory(root.appendingPathComponent(".pending", isDirectory: true))
		for folder in try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil) {
			do {
				guard ChooserFiles.isID(folder.lastPathComponent) else { throw failure() }
				_ = try directory(folder)
				let journal = folder.appendingPathComponent("journal")
				var entries: [Entry] = []
				var committed = false
				if FileManager.default.fileExists(atPath: journal.path) {
					try regular(journal)
					let lines = try records(journal)
					guard lines.count >= 2, lines[0] == "chooser-1", ["pending", "committed"].contains(lines[1]) else { throw failure() }
					committed = lines[1] == "committed"
					var ids = Set<String>()
					for line in lines.dropFirst(2) {
						guard line.hasPrefix("s:") || line.hasPrefix("p:") else { throw failure() }
						let id = String(line.dropFirst(2))
						guard ChooserFiles.isID(id), ids.insert(id).inserted else { throw failure() }
						entries.append(Entry(id: id, promoting: line.hasPrefix("p:")))
					}
				}
				if !committed { try rollback(root: root, folder: folder, entries: entries, operations: operations) }
				try removeStaging(folder, operations: operations)
			}
			catch { diagnostic() }
		}
	}

	private static func records(_ file: URL) throws -> [String] {
		guard let input = InputStream(url: file) else { throw failure() }
		input.open(); defer { input.close() }
		var buffer = [UInt8](repeating: 0, count: 4096)
		var line: [UInt8] = []
		var lines: [String] = []
		while true {
			let count = input.read(&buffer, maxLength: buffer.count)
			if count < 0 { throw failure() }
			if count == 0 { break }
			for byte in buffer.prefix(count) {
				if byte == 10 { lines.append(String(decoding: line, as: UTF8.self)); line.removeAll(keepingCapacity: true) }
				else {
					guard byte < 128, line.count < 40 else { throw failure() }
					line.append(byte)
				}
			}
		}
		if !line.isEmpty { lines.append(String(decoding: line, as: UTF8.self)) }
		return lines
	}

	private static func rollback(root: URL, folder: URL, entries: [Entry], operations: Operations) throws {
		var failed = false
		for entry in entries where entry.promoting {
			do {
				let source = folder.appendingPathComponent(entry.id)
				if !FileManager.default.fileExists(atPath: source.path) {
					try removeRegular(root.appendingPathComponent(entry.id), operations: operations)
				}
			}
			catch { failed = true }
		}
		if failed { throw failure() }
	}

	private static func removeStaging(_ folder: URL, operations: Operations) throws {
		let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
		for file in files {
			guard ChooserFiles.isID(file.lastPathComponent) || ["journal", "journal.tmp"].contains(file.lastPathComponent) else { throw failure() }
			try regular(file)
		}
		for file in files where !file.lastPathComponent.hasPrefix("journal") { try removeRegular(file, operations: operations) }
		try removeRegular(folder.appendingPathComponent("journal.tmp"), operations: operations)
		try removeRegular(folder.appendingPathComponent("journal"), operations: operations)
		try operations.remove(folder)
	}
	private static func removeRegular(_ file: URL, operations: Operations) throws {
		try canonical(file)
		if FileManager.default.fileExists(atPath: file.path) { try regular(file); try operations.remove(file) }
	}
	private static func canonical(_ file: URL) throws {
		guard file.resolvingSymlinksInPath().standardizedFileURL.path == file.standardizedFileURL.path else { throw failure() }
	}
	private static func regular(_ file: URL) throws {
		try canonical(file)
		guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw failure() }
	}
	private static func directory(_ file: URL) throws -> URL {
		try canonical(file)
		try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		return file
	}
	private static func failure() -> ChooserFailure { return ChooserFailure(code: .cacheFailed, detail: "Cache transaction could not be completed.") }
	private static func diagnostic() { NSLog("Chooser cache cleanup/recovery incomplete; private entries retained for retry.") }
}
