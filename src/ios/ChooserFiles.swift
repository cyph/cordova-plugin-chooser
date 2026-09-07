import Foundation

struct ChooserFailure: LocalizedError {
	let message: String
	var errorDescription: String? { return message }
}

/** Bounded I/O and ownership checks, independently usable by the native fixtures. */
enum ChooserFiles {
	static let maxSafeInteger: Int64 = 9007199254740991

	static func copy(input: InputStream, output: OutputStream, limit: Int64, canceled: () -> Bool) throws -> Int64 {
		input.open()
		output.open()
		defer {
			input.close()
			output.close()
		}
		if input.streamStatus == .error { throw input.streamError ?? ChooserFailure(message: "READ_FAILED: Cannot open selected file.") }
		if output.streamStatus == .error { throw output.streamError ?? ChooserFailure(message: "COPY_FAILED: Cannot open cached file.") }
		var buffer = [UInt8](repeating: 0, count: 64 * 1024)
		var total: Int64 = 0
		while true {
			if canceled() { throw ChooserFailure(message: "READ_INTERRUPTED: Request was reset.") }
			let count = input.read(&buffer, maxLength: buffer.count)
			if count < 0 { throw input.streamError ?? ChooserFailure(message: "READ_FAILED: Cannot read selected file.") }
			if count == 0 { return total }
			if total > maxSafeInteger - Int64(count) || (limit > 0 && Int64(count) > limit - total) {
				throw ChooserFailure(message: "FILE_TOO_LARGE: Selected file exceeds the byte limit.")
			}
			try buffer.withUnsafeBufferPointer { pointer in
				guard let base = pointer.baseAddress else { return }
				var offset = 0
				while offset < count {
					if canceled() { throw ChooserFailure(message: "READ_INTERRUPTED: Request was reset.") }
					let written = output.write(base.advanced(by: offset), maxLength: count - offset)
					if written <= 0 { throw output.streamError ?? ChooserFailure(message: "COPY_FAILED: Cannot write cached file.") }
					offset += written
				}
			}
			total += Int64(count)
		}
	}

	static func directory(in cache: URL) throws -> URL {
		let root = cache.resolvingSymlinksInPath().appendingPathComponent("cordova-plugin-chooser", isDirectory: true).standardizedFileURL
		guard root.resolvingSymlinksInPath().path == root.path else {
			throw ChooserFailure(message: "CACHE_FAILED: Cache directory must not be a symbolic link.")
		}
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		return root
	}

	static func create(in cache: URL) throws -> URL {
		let root = try directory(in: cache)
		for _ in 0..<10 {
			let file = root.appendingPathComponent(UUID().uuidString.lowercased())
			if !FileManager.default.fileExists(atPath: file.path) && FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) {
				return file
			}
		}
		throw ChooserFailure(message: "CACHE_FAILED: Cannot allocate a private cache file.")
	}

	static func release(in cache: URL, id: String) throws {
		guard id.utf8.count == 36, id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
			throw ChooserFailure(message: "INVALID_ARGUMENT: Expected a managed file id.")
		}
		let file = try directory(in: cache).appendingPathComponent(id)
		guard file.resolvingSymlinksInPath().path == file.path else {
			throw ChooserFailure(message: "INVALID_ARGUMENT: Not a managed regular file.")
		}
		if FileManager.default.fileExists(atPath: file.path) {
			guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
				throw ChooserFailure(message: "INVALID_ARGUMENT: Not a managed regular file.")
			}
			try FileManager.default.removeItem(at: file)
		}
	}
}
