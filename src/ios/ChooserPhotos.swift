import Foundation
import PhotosUI
import UniformTypeIdentifiers

/** Representation selection never decodes or re-encodes an image/video. */
enum ChooserPhotos {
	static func configuration(mediaTypes: [String], multiple: Bool, maxFiles: Int64) -> PHPickerConfiguration {
		var configuration = PHPickerConfiguration()
		configuration.preferredAssetRepresentationMode = .current
		configuration.selection = .ordered
		configuration.selectionLimit = multiple ? Int(maxFiles) : 1
		configuration.filter = mediaTypes.count == 2 ? .any(of: [.images, .videos]) : (mediaTypes[0] == "image" ? .images : .videos)
		return configuration
	}

	static func identifier(for provider: NSItemProvider, mediaTypes: [String]) throws -> String {
		for identifier in provider.registeredTypeIdentifiers {
			guard let type = UTType(identifier) else { continue }
			if mediaTypes.contains("image") && type.conforms(to: .image) { return identifier }
			if mediaTypes.contains("video") && type.conforms(to: .movie) { return identifier }
		}
		throw ChooserFailure(code: .readFailed, detail: "The photo provider offers no requested image or video representation.")
	}

	static func metadata(for provider: NSItemProvider, identifier: String) -> [String: Any] {
		let type = UTType(identifier)
		let supplied = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		var name = supplied.isEmpty ? "selected-file" : supplied
		if (name as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension { name += "." + ext }
		return ["name": name, "mediaType": type?.preferredMIMEType ?? "application/octet-stream", "size": NSNull()]
	}

	/** The handler consumes/stages the URL before NSItemProvider may remove it. */
	static func load(provider: NSItemProvider, identifier: String, request: ChooserRequest,
		consume: @escaping (URL) throws -> [String: Any]) throws -> [String: Any] {
		try request.checkCanceled()
		let load = ChooserPhotoLoad(consume: consume)
		let progress = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in load.receive(url: url, error: error) }
		request.loading(progress)
		defer { request.loading(nil) }
		return try load.wait()
	}
}

// NSItemProvider chooses the callback executor. The callback consumes its URL
// synchronously; the semaphore publishes the completed result to the worker.
private final class ChooserPhotoLoad: @unchecked Sendable {
	private let consume: (URL) throws -> [String: Any]
	private let done = DispatchSemaphore(value: 0)
	private let lock = NSLock()
	private var received = false
	private var result: Result<[String: Any], Error>?
	init(consume: @escaping (URL) throws -> [String: Any]) { self.consume = consume }
	func receive(url: URL?, error: Error?) {
		lock.lock()
		guard !received else { lock.unlock(); return }
		received = true
		lock.unlock()
		let outcome: Result<[String: Any], Error>
		do {
			if let error = error { throw error }
			guard let url = url else { throw ChooserFailure(code: .readFailed, detail: "The photo provider returned no file representation.") }
			outcome = .success(try consume(url))
		}
		catch { outcome = .failure(error) }
		lock.lock(); result = outcome; lock.unlock()
		done.signal()
	}
	func wait() throws -> [String: Any] {
		done.wait()
		lock.lock(); let value = result; lock.unlock()
		guard let value = value else { throw ChooserFailure(code: .readFailed, detail: "The photo provider returned no result.") }
		return try value.get()
	}
}
