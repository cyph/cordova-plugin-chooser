import Foundation
import UIKit
import MobileCoreServices
#if canImport(Cordova)
import Cordova
#endif
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

private final class ChooserRequest {
	let callback: String
	let accept: String
	let mode: String
	let multiple: Bool
	let limit: Int64
	var selected = false // Main-thread only.
	private let lock = NSLock()
	private var invalidated = false

	init(callback: String, accept: String, mode: String, multiple: Bool, limit: Int64) {
		self.callback = callback
		self.accept = accept
		self.mode = mode
		self.multiple = multiple
		self.limit = limit
	}

	var canceled: Bool {
		lock.lock()
		defer { lock.unlock() }
		return invalidated
	}

	func cancel() {
		lock.lock()
		invalidated = true
		lock.unlock()
	}
}

private final class ChooserDocumentPicker: UIDocumentPickerViewController {
	var request: ChooserRequest?

	// From @herdwatch-apps/@MaximBelov: let UIKit intersect with the app's mask.
	override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .all }
}

@objc(Chooser)
class Chooser: CDVPlugin {
	private var active: ChooserRequest?
	private var picker: ChooserDocumentPicker?
	private let work = DispatchQueue(label: "com.cyph.cordova.chooser.files", qos: .userInitiated)

	@objc(getFile:)
	func getFile(command: CDVInvokedUrlCommand) {
		DispatchQueue.main.async {
			guard command.arguments.count >= 2,
				let accept = command.arguments[0] as? String,
				let includeData = command.arguments[1] as? Bool else {
				self.send("INVALID_ARGUMENT: Expected a MIME filter and includeData boolean.", .error, command.callbackId)
				return
			}
			self.begin(callback: command.callbackId, accept: accept, mode: includeData ? "data" : "metadata", multiple: false, limit: 0)
		}
	}

	@objc(pick:)
	func pick(command: CDVInvokedUrlCommand) {
		DispatchQueue.main.async {
			guard let options = command.arguments.first as? [String: Any],
				let accept = options["accept"] as? String,
				let mode = options["mode"] as? String,
				["data", "metadata", "copy"].contains(mode),
				let multiple = options["multiple"] as? Bool,
				let number = options["maxFileSize"] as? NSNumber,
				CFGetTypeID(number) != CFBooleanGetTypeID() else {
				self.send("INVALID_ARGUMENT: Invalid picker options.", .error, command.callbackId)
				return
			}
			let size = number.doubleValue
			guard size.isFinite, size >= 0, size <= Double(ChooserFiles.maxSafeInteger), size.rounded(.down) == size else {
				self.send("INVALID_ARGUMENT: Invalid byte limit.", .error, command.callbackId)
				return
			}
			self.begin(callback: command.callbackId, accept: accept, mode: mode, multiple: multiple, limit: Int64(size))
		}
	}

	@objc(releaseFile:)
	func releaseFile(command: CDVInvokedUrlCommand) {
		guard let id = command.arguments.first as? String else {
			send("INVALID_ARGUMENT: Expected a managed file id.", .error, command.callbackId)
			return
		}
		work.async {
			do {
				try ChooserFiles.release(in: self.cacheDirectory(), id: id)
				DispatchQueue.main.async { self.send("", .ok, command.callbackId) }
			}
			catch {
				let message = error.localizedDescription
				DispatchQueue.main.async { self.send(message, .error, command.callbackId) }
			}
		}
	}

	private func cacheDirectory() throws -> URL {
		guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
			throw ChooserFailure(message: "CACHE_FAILED: Private cache directory is unavailable.")
		}
		return cache
	}

	private func begin(callback: String, accept: String, mode: String, multiple: Bool, limit: Int64) {
		guard active == nil else {
			send("BUSY: A file picker is already active.", .error, callback)
			return
		}
		guard let presenter = viewController, presenter.viewIfLoaded?.window != nil,
			presenter.presentedViewController == nil else {
			send("PICKER_FAILED: The app is not ready to present a file picker.", .error, callback)
			return
		}
		let normalized = accept.lowercased().components(separatedBy: .whitespacesAndNewlines).joined()
		let request = ChooserRequest(callback: callback, accept: normalized.isEmpty ? "*/*" : normalized, mode: mode, multiple: multiple, limit: limit)
		let utis = identifiers(for: request.accept)
		let controller: ChooserDocumentPicker
		#if canImport(UniformTypeIdentifiers)
		if #available(iOS 14.0, *) {
			controller = ChooserDocumentPicker(forOpeningContentTypes: utis.map { UTType($0) ?? .item }, asCopy: mode != "copy")
		}
		else {
			controller = ChooserDocumentPicker(documentTypes: utis, in: mode == "copy" ? .open : .import)
		}
		#else
		controller = ChooserDocumentPicker(documentTypes: utis, in: mode == "copy" ? .open : .import)
		#endif
		controller.request = request
		controller.delegate = self
		controller.allowsMultipleSelection = multiple
		controller.presentationController?.delegate = self
		if let popover = controller.popoverPresentationController {
			popover.sourceView = presenter.view
			popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
			popover.permittedArrowDirections = []
		}
		active = request
		picker = controller
		presenter.present(controller, animated: true) {
			controller.presentationController?.delegate = self
		}
	}

	private func identifiers(for accept: String) -> [String] {
		return accept.components(separatedBy: ",").map { mime in
			// Movie includes audiovisual formats which public.video alone may exclude.
			let wildcards = [
				"audio/*": "public.audio", "font/*": "public.font",
				"image/*": "public.image", "text/*": "public.text", "video/*": "public.movie"
			]
			if let identifier = wildcards[mime] { return identifier }
			if mime.contains("*") || mime.isEmpty { return "public.item" }
			#if canImport(UniformTypeIdentifiers)
			if #available(iOS 14.0, *) {
				if let type = UTType(mimeType: mime), !type.isDynamic { return type.identifier }
				return "public.item"
			}
			#endif
			if let identifier = UTTypeCreatePreferredIdentifierForTag(kUTTagClassMIMEType, mime as CFString, nil)?.takeRetainedValue() as String?,
				!identifier.hasPrefix("dyn.") {
				return identifier
			}
			return "public.item"
		}
	}

	private func mediaType(for url: URL) -> String {
		#if canImport(UniformTypeIdentifiers)
		if #available(iOS 14.0, *) {
			return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
		}
		#endif
		if let uti = UTTypeCreatePreferredIdentifierForTag(kUTTagClassFilenameExtension, url.pathExtension as CFString, nil)?.takeRetainedValue(),
			let type = UTTypeCopyPreferredTagWithClass(uti, kUTTagClassMIMEType)?.takeRetainedValue() as String? {
			return type
		}
		return "application/octet-stream"
	}

	private func selected(_ controller: UIDocumentPickerViewController, urls: [URL]) {
		guard let request = (controller as? ChooserDocumentPicker)?.request, active === request,
			!request.selected, !request.canceled else { return }
		request.selected = true
		if urls.isEmpty {
			complete(request, message: "RESULT_CANCELED", status: .ok)
			return
		}
		var unique: [URL] = []
		for url in urls where !unique.contains(url) {
			unique.append(url)
			if !request.multiple { break }
		}
		work.async {
			var created: [URL] = []
			do {
				var results: [[String: Any]] = []
				for url in unique {
					if request.canceled { throw ChooserFailure(message: "READ_INTERRUPTED: Request was reset.") }
					results.append(try self.read(url: url, request: request, created: &created))
				}
				let object: Any = request.multiple ? results as Any : results[0] as Any
				let json = try JSONSerialization.data(withJSONObject: object, options: [])
				guard let message = String(data: json, encoding: .utf8) else {
					throw ChooserFailure(message: "READ_FAILED: Could not serialize file result.")
				}
				let owned = created
				DispatchQueue.main.async {
					if self.active === request && !request.canceled {
						self.complete(request, message: message, status: .ok)
					}
					else {
						self.work.async { self.removePartialFiles(owned) }
					}
				}
			}
			catch {
				self.removePartialFiles(created)
				let message = error.localizedDescription
				DispatchQueue.main.async { self.complete(request, message: message, status: .error) }
			}
		}
	}

	private func read(url: URL, request: ChooserRequest, created: inout [URL]) throws -> [String: Any] {
		guard url.isFileURL else { throw ChooserFailure(message: "READ_FAILED: Expected a file URL from the document picker.") }
		let scoped = url.startAccessingSecurityScopedResource()
		defer { if scoped { url.stopAccessingSecurityScopedResource() } }
		var coordinationError: NSError?
		var readError: Error?
		var result: [String: Any]?
		NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
			do {
				let values = try coordinated.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
				guard values.isRegularFile == true else { throw ChooserFailure(message: "READ_FAILED: Select a regular file, not a directory or package.") }
				let reportedSize: Any = values.fileSize.map { $0 as Any } ?? NSNull()
				var file: [String: Any] = [
					"name": coordinated.lastPathComponent,
					"mediaType": self.mediaType(for: coordinated),
					"uri": coordinated.absoluteString,
					"size": reportedSize
				]
				if request.mode == "data" {
					// This legacy API necessarily materializes the file; metadata mode does not.
					let data = try Data(contentsOf: coordinated)
					file["data"] = data.base64EncodedString()
					file["size"] = data.count
				}
				else if request.mode == "copy" {
					let destination = try ChooserFiles.create(in: self.cacheDirectory())
					created.append(destination)
					guard let input = InputStream(url: coordinated), let output = OutputStream(url: destination, append: false) else {
						throw ChooserFailure(message: "COPY_FAILED: Could not open file streams.")
					}
					let count = try ChooserFiles.copy(input: input, output: output, limit: request.limit, canceled: { request.canceled })
					file["sourceUri"] = url.absoluteString
					file["uri"] = destination.absoluteString
					file["id"] = destination.lastPathComponent
					file["size"] = count
				}
				result = file
			}
			catch { readError = error }
		}
		if let error = coordinationError { throw error }
		if let error = readError { throw error }
		guard let file = result else { throw ChooserFailure(message: "READ_FAILED: File coordination returned no result.") }
		return file
	}

	private func removePartialFiles(_ urls: [URL]) {
		for url in urls {
			// Only generated paths from this request are passed here.
			try? FileManager.default.removeItem(at: url)
		}
	}

	private func complete(_ request: ChooserRequest, message: String, status: CDVCommandStatus) {
		guard active === request, !request.canceled else { return }
		active = nil
		picker = nil
		send(message, status, request.callback)
	}

	private func send(_ message: String, _ status: CDVCommandStatus, _ callback: String) {
		commandDelegate?.send(CDVPluginResult(status: status, messageAs: message), callbackId: callback)
	}

	override func onReset() {
		let reset = {
			self.active?.cancel()
			self.active = nil
			self.picker?.dismiss(animated: false, completion: nil)
			self.picker = nil
		}
		if Thread.isMainThread { reset() }
		else { DispatchQueue.main.async(execute: reset) }
	}
}

extension Chooser: UIDocumentPickerDelegate {
	func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
		selected(controller, urls: urls)
	}

	func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentAt url: URL) {
		selected(controller, urls: [url])
	}

	func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
		guard let request = (controller as? ChooserDocumentPicker)?.request, !request.selected else { return }
		complete(request, message: "RESULT_CANCELED", status: .ok)
	}
}

extension Chooser: UIAdaptivePresentationControllerDelegate {
	@available(iOS 13.0, *)
	func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
		if let controller = presentationController.presentedViewController as? UIDocumentPickerViewController {
			documentPickerWasCancelled(controller)
		}
	}
}
