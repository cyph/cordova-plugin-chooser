import Foundation
import Darwin

/** Bounded I/O and ownership checks, independently usable by the native fixtures. */
enum ChooserFiles {
	static let maxSafeInteger: Int64 = 9007199254740991

	static func copy(input: InputStream, output: OutputStream, limit: Int64, canceled: () -> Bool) throws -> Int64 {
		return try copy(input: input, output: output, budget: ChooserBudget(fileLimit: limit, totalLimit: 0), canceled: canceled)
	}

	static func copy(input: InputStream, output: OutputStream, budget: ChooserBudget, canceled: () -> Bool) throws -> Int64 {
		input.open()
		output.open()
		defer {
			input.close()
			output.close()
		}
		if input.streamStatus == .error { throw input.streamError ?? ChooserFailure(code: .readFailed, detail: "Cannot open selected file.") }
		if output.streamStatus == .error { throw output.streamError ?? ChooserFailure(code: .copyFailed, detail: "Cannot open cached file.") }
		var buffer = [UInt8](repeating: 0, count: 64 * 1024)
		var total: Int64 = 0
		while true {
			if canceled() { throw ChooserFailure(code: .readInterrupted, detail: "Request was reset.") }
			let count = input.read(&buffer, maxLength: buffer.count)
			if count < 0 { throw input.streamError ?? ChooserFailure(code: .readFailed, detail: "Cannot read selected file.") }
			if count == 0 { return total }
			try budget.consume(fileBytes: total, count: count)
			try buffer.withUnsafeBufferPointer { pointer in
				guard let base = pointer.baseAddress else { return }
				var offset = 0
				while offset < count {
					if canceled() { throw ChooserFailure(code: .readInterrupted, detail: "Request was reset.") }
					let written = output.write(base.advanced(by: offset), maxLength: count - offset)
					if written <= 0 { throw output.streamError ?? ChooserFailure(code: .copyFailed, detail: "Cannot write cached file.") }
					offset += written
				}
			}
			total += Int64(count)
		}
	}

	static func directory(in cache: URL) throws -> URL {
		let root = cache.resolvingSymlinksInPath().appendingPathComponent("cordova-plugin-chooser", isDirectory: true).standardizedFileURL
		guard root.resolvingSymlinksInPath().path == root.path else {
			throw ChooserFailure(code: .cacheFailed, detail: "Cache directory must not be a symbolic link.")
		}
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		return root
	}

	static func create(in cache: URL) throws -> URL {
		let root = try directory(in: cache)
		return try createFile(in: root)
	}

	static func createFile(in root: URL) throws -> URL {
		for _ in 0..<10 {
			let file = root.appendingPathComponent(UUID().uuidString.lowercased())
			// Exclusive creation cannot overwrite an existing entry, even on a UUID collision.
			let descriptor = file.path.withCString { Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600)) }
			if descriptor >= 0 {
				Darwin.close(descriptor)
				return file
			}
			if errno != EEXIST { throw ChooserFailure(code: .cacheFailed, detail: "Cannot allocate a private cache file.") }
		}
		throw ChooserFailure(code: .cacheFailed, detail: "Cannot allocate a private cache file.")
	}

	static func entryExists(_ file: URL) throws -> Bool {
		var information = stat()
		if file.path.withCString({ Darwin.lstat($0, &information) }) == 0 { return true }
		if errno == ENOENT { return false }
		throw ChooserFailure(code: .cacheFailed, detail: "Cannot inspect cache directory.")
	}

	static func release(in cache: URL, id: String) throws {
		guard isID(id) else {
			throw ChooserFailure(code: .invalidArgument, detail: "Expected a managed file id.")
		}
		let file = try directory(in: cache).appendingPathComponent(id)
		guard file.resolvingSymlinksInPath().path == file.path else {
			throw ChooserFailure(code: .invalidArgument, detail: "Not a managed regular file.")
		}
		if try entryExists(file) {
			guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
				throw ChooserFailure(code: .invalidArgument, detail: "Not a managed regular file.")
			}
			try FileManager.default.removeItem(at: file)
		}
	}

	static func isID(_ id: String) -> Bool {
		return id.utf8.count == 36 && id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
	}
}
