import Foundation
import UIKit
import MobileCoreServices
#if canImport(Cordova)
import Cordova
#endif
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

private final class ChooserDocumentPicker: UIDocumentPickerViewController {
	var request: ChooserRequest?

	// Let UIKit intersect with the app's supported orientation mask.
	override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .all }
}

@objc(Chooser)
class Chooser: CDVPlugin {
	private var active: ChooserRequest?
	private var picker: ChooserDocumentPicker?
	private var generation: UInt64 = 0 // Main-thread only, including release completions.

	private func onMain(_ action: @escaping () -> Void) {
		if Thread.isMainThread { action() }
		else { DispatchQueue.main.async(execute: action) }
	}

	@objc(getFile:)
	func getFile(command: CDVInvokedUrlCommand) {
		onMain {
			guard command.arguments.count >= 2,
				let accept = command.arguments[0] as? String,
				let includeData = command.arguments[1] as? Bool else {
				self.send(ChooserFailure(code: .invalidArgument, detail: "Expected a MIME filter and includeData boolean.").message, .error, command.callbackId)
				return
			}
			self.begin(callback: command.callbackId, accept: accept, mode: includeData ? .data : .metadata, multiple: false, limit: 0)
		}
	}

	@objc(pick:)
	func pick(command: CDVInvokedUrlCommand) {
		onMain {
			guard let options = command.arguments.first as? [String: Any],
				let accept = options["accept"] as? String,
				let modeName = options["mode"] as? String,
				let mode = ChooserReadMode(rawValue: modeName),
				let multiple = options["multiple"] as? Bool else {
				self.send(ChooserFailure(code: .invalidArgument, detail: "Invalid picker options.").message, .error, command.callbackId)
				return
			}
			do {
				let limit = try self.limitOption(options, name: "maxFileSize")
				let maxFiles = try self.limitOption(options, name: "maxFiles")
				let maxTotalSize = try self.limitOption(options, name: "maxTotalSize")
				self.begin(callback: command.callbackId, accept: accept, mode: mode, multiple: multiple, limit: limit, maxFiles: maxFiles, maxTotalSize: maxTotalSize)
			}
			catch { self.send(error.localizedDescription, .error, command.callbackId) }
		}
	}

	private func limitOption(_ options: [String: Any], name: String) throws -> Int64 {
		guard let value = options[name] else { return 0 }
		guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
			throw ChooserFailure(code: .invalidArgument, detail: "Expected a numeric limit.")
		}
		let size = number.doubleValue
		guard size.isFinite, size >= 0, size <= Double(ChooserFiles.maxSafeInteger), size.rounded(.down) == size else {
			throw ChooserFailure(code: .invalidArgument, detail: "Expected a nonnegative safe-integer limit.")
		}
		return Int64(size)
	}

	@objc(releaseFile:)
	func releaseFile(command: CDVInvokedUrlCommand) {
		onMain {
			guard let id = command.arguments.first as? String else {
				self.send(ChooserFailure(code: .invalidArgument, detail: "Expected a managed file id.").message, .error, command.callbackId)
				return
			}
			let owner = self.generation
			ChooserTransaction.housekeeping.async {
				let message: String
				let status: CDVCommandStatus
				do {
					try ChooserFiles.release(in: self.cacheDirectory(), id: id)
					message = ""
					status = .ok
				}
				catch {
					message = error.localizedDescription
					status = .error
				}
				DispatchQueue.main.async {
					if self.generation == owner { self.send(message, status, command.callbackId) }
				}
			}
		}
	}

	private func cacheDirectory() throws -> URL {
		guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
			throw ChooserFailure(code: .cacheFailed, detail: "Private cache directory is unavailable.")
		}
		return cache
	}

	private func begin(callback: String, accept: String, mode: ChooserReadMode, multiple: Bool, limit: Int64, maxFiles: Int64 = 0, maxTotalSize: Int64 = 0) {
		guard active == nil else {
			send(ChooserFailure(code: .busy, detail: "A file picker is already active.").message, .error, callback)
			return
		}
		guard let presenter = viewController, presenter.viewIfLoaded?.window != nil,
			presenter.presentedViewController == nil else {
			send(ChooserFailure(code: .pickerFailed, detail: "The app is not ready to present a file picker.").message, .error, callback)
			return
		}
		guard let worker = ChooserWork.reserve() else {
			send(ChooserFailure(code: .busy, detail: "Previous provider reads are still pending.").message, .error, callback)
			return
		}
		let normalized = accept.lowercased().components(separatedBy: .whitespacesAndNewlines).joined()
		let request = ChooserRequest(callback: callback, accept: normalized.isEmpty ? "*/*" : normalized, mode: mode, multiple: multiple, limit: limit, maxFiles: maxFiles, maxTotalSize: maxTotalSize, worker: worker)
		let utis = identifiers(for: request.accept)
		let controller: ChooserDocumentPicker
		#if canImport(UniformTypeIdentifiers)
		if #available(iOS 14.0, *) {
			let types = utis.compactMap { UTType($0) }
			controller = ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: mode != .copy)
		}
		else {
			controller = ChooserDocumentPicker(documentTypes: utis, in: mode == .copy ? .open : .import)
		}
		#else
		controller = ChooserDocumentPicker(documentTypes: utis, in: mode == .copy ? .open : .import)
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
		var identifiers = accept.components(separatedBy: ",").map { mime in
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
		// Compatibility aliases cover older iWork document registrations.
		for (legacy, alternate) in [
			("com.apple.iwork.pages.sffpages", "com.apple.iwork.pages.pages"),
			("com.apple.iwork.numbers.sffnumbers", "com.apple.iwork.numbers.numbers")
		] where identifiers.contains(legacy) && !identifiers.contains(alternate) {
			identifiers.append(alternate)
		}
		return identifiers
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
			request.process() else { return }
		if urls.isEmpty {
			complete(request, message: "RESULT_CANCELED", status: .ok)
			return
		}
		var unique: [URL] = []
		var seen = Set<URL>()
		for url in urls where seen.insert(url).inserted {
			unique.append(url)
			if !request.multiple { break }
		}
		if request.mode == .copy && request.maxFiles > 0 && Int64(unique.count) > request.maxFiles {
			complete(request, message: ChooserFailure(code: .tooManyFiles, detail: "Selection exceeds the file count limit.").message, status: .error)
			return
		}
		let selection = unique
		guard let worker = request.worker else {
			complete(request, message: ChooserFailure(code: .readFailed, detail: "Missing request worker.").message, status: .error)
			return
		}
		worker.run {
			do {
				try request.checkCanceled()
				if request.mode == .copy { request.attach(try ChooserTransaction.begin(in: self.cacheDirectory())) }
				var results: [[String: Any]] = []
				for url in selection {
					if request.canceled { throw ChooserFailure(code: .readInterrupted, detail: "Request was reset.") }
					results.append(try self.read(url: url, request: request))
				}
				try request.checkCanceled()
				try request.transaction?.commit(canceled: { request.canceled })
				let object: Any = request.multiple ? results as Any : results[0] as Any
				let json = try JSONSerialization.data(withJSONObject: object, options: [])
				guard let message = String(data: json, encoding: .utf8) else {
					throw ChooserFailure(code: .readFailed, detail: "Could not serialize file result.")
				}
				DispatchQueue.main.async {
					let delivered = self.complete(request, message: message, status: .ok)
					request.finishResources(delivered: delivered)
				}
			}
			catch {
				request.finishResources(delivered: false)
				let message = error.localizedDescription
				DispatchQueue.main.async { self.complete(request, message: message, status: .error) }
			}
		}
	}

	private func read(url: URL, request: ChooserRequest) throws -> [String: Any] {
		guard url.isFileURL else { throw ChooserFailure(code: .readFailed, detail: "Expected a file URL from the document picker.") }
		let scoped = url.startAccessingSecurityScopedResource()
		defer { if scoped { url.stopAccessingSecurityScopedResource() } }
		var coordinationError: NSError?
		var readError: Error?
		var result: [String: Any]?
		let coordinator = NSFileCoordinator()
		request.coordinate(using: coordinator)
		defer { request.coordinate(using: nil) }
		try request.checkCanceled()
		coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
			do {
				try request.checkCanceled()
				let values = try coordinated.resourceValues(forKeys: [.isRegularFileKey])
				guard values.isRegularFile == true else { throw ChooserFailure(code: .readFailed, detail: "Select a regular file, not a directory or package.") }
				// Size is optional provider metadata; failure must not block a counted copy.
				let sizeValues = try? coordinated.resourceValues(forKeys: [.fileSizeKey])
				let reportedSize: Any = sizeValues?.fileSize.flatMap { size -> Int? in
					return size >= 0 && Int64(size) <= ChooserFiles.maxSafeInteger ? size : nil
				}.map { $0 as Any } ?? NSNull()
				var file: [String: Any] = [
					"name": coordinated.lastPathComponent,
					"mediaType": self.mediaType(for: coordinated),
					"uri": coordinated.absoluteString,
					"size": reportedSize
				]
				if request.mode == .data {
					// This legacy API necessarily materializes the file; metadata mode does not.
					let data = try Data(contentsOf: coordinated)
					file["data"] = data.base64EncodedString()
					file["size"] = data.count
				}
				else if request.mode == .copy {
					guard let transaction = request.transaction else { throw ChooserFailure(code: .cacheFailed, detail: "Missing copy transaction.") }
					let destination = try transaction.create()
					guard let input = InputStream(url: coordinated), let output = OutputStream(url: destination, append: false) else {
						throw ChooserFailure(code: .copyFailed, detail: "Could not open file streams.")
					}
					let count = try ChooserFiles.copy(input: input, output: output, budget: request.budget, canceled: { request.canceled })
					file["sourceUri"] = url.absoluteString
					file["uri"] = try transaction.destination(for: destination).absoluteString
					file["id"] = destination.lastPathComponent
					file["size"] = count
				}
				result = file
			}
			catch { readError = error }
		}
		if let error = coordinationError { throw error }
		if let error = readError { throw error }
		guard let file = result else { throw ChooserFailure(code: .readFailed, detail: "File coordination returned no result.") }
		return file
	}

	@discardableResult
	private func complete(_ request: ChooserRequest, message: String, status: CDVCommandStatus) -> Bool {
		guard active === request, request.complete() else { return false }
		defer { request.finish() }
		active = nil
		picker = nil
		guard commandDelegate != nil else { return false }
		send(message, status, request.callback)
		return true
	}

	private func send(_ message: String, _ status: CDVCommandStatus, _ callback: String) {
		commandDelegate?.send(CDVPluginResult(status: status, messageAs: message), callbackId: callback)
	}

	override func onReset() {
		let reset = {
			self.generation &+= 1
			self.active?.cancel()
			self.active = nil
			self.picker?.dismiss(animated: false, completion: nil)
			self.picker = nil
		}
		if Thread.isMainThread { reset() }
		else { DispatchQueue.main.async(execute: reset) }
	}

	override func dispose() {
		onReset()
		super.dispose()
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
		guard let request = (controller as? ChooserDocumentPicker)?.request, request.state == .selecting else { return }
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
