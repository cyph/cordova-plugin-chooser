import Foundation
import UIKit
import PhotosUI
import UniformTypeIdentifiers
#if canImport(Cordova)
import Cordova
#endif

private final class ChooserDocumentPicker: UIDocumentPickerViewController {
	var request: ChooserRequest?
	// Let UIKit intersect with the app's supported orientation mask.
	override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .all }
}

#if compiler(>=5.9)
@MainActor
#endif
private final class ChooserPresentation {
	let request: ChooserRequest
	let controller: UIViewController
	// UIKit may defer presentation without setting any controller flags yet.
	var pending = true
	var finishing = false
	var animated = true
	var completion: ChooserMainAction?

	init(request: ChooserRequest, controller: UIViewController) {
		self.request = request
		self.controller = controller
	}
}

@objc(Chooser)
class Chooser: CDVPlugin {
	#if compiler(>=5.9)
	@MainActor
	#endif
	private var active: ChooserRequest?
	#if compiler(>=5.9)
	@MainActor
	#endif
	private var presentation: ChooserPresentation?
	#if compiler(>=5.9)
	@MainActor
	#endif
	private var generation: UInt64 = 0
	let resources = ChooserResources(cache: Chooser.cacheDirectory)

	@objc(pick:)
	func pick(command: CDVInvokedUrlCommand) {
		let reference = ChooserMainReference((self, command))
		ChooserMain.run {
			let (plugin, command) = reference.value
			do {
				guard command.arguments.count == 1, let options = command.arguments.first as? [String: Any],
					let id = options["requestId"] as? String, !id.isEmpty,
					let source = options["source"] as? String, ["documents", "photos"].contains(source),
					let accept = options["accept"] as? String,
					let modeName = options["mode"] as? String, let mode = ChooserReadMode(rawValue: modeName) else {
					throw ChooserFailure(code: .invalidArgument, detail: "Invalid picker options.")
				}
				let multiple = try Self.boolean(options["multiple"])
				_ = try Self.boolean(options["localOnly"])
				let limit = try Self.integer(options["maxFileSize"])
				let maxFiles = try Self.integer(options["maxFiles"])
				let maxTotalSize = try Self.integer(options["maxTotalSize"])
				let mediaTypes: [String]
				if source == "photos" {
					guard let types = options["mediaTypes"] as? [String], !types.isEmpty,
						types.allSatisfy({ ["image", "video"].contains($0) }), Set(types).count == types.count else {
						throw ChooserFailure(code: .invalidArgument, detail: "Invalid photo media types.")
					}
					mediaTypes = types
				} else { mediaTypes = [] }
				let normalized = accept.lowercased().components(separatedBy: .whitespacesAndNewlines).joined()
				let request = ChooserRequest(callback: command.callbackId, accept: normalized.isEmpty ? "*/*" : normalized,
					mode: mode, multiple: multiple, limit: limit, maxFiles: maxFiles, maxTotalSize: maxTotalSize,
					worker: ChooserWork.reserve(), id: id, source: source, mediaTypes: mediaTypes)
				plugin.begin(request)
			} catch { plugin.sendFailure(error, callback: command.callbackId, fallback: .invalidArgument) }
		}
	}

	private static func boolean(_ value: Any?) throws -> Bool {
		guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
			throw ChooserFailure(code: .invalidArgument, detail: "Expected a boolean.")
		}
		return number.boolValue
	}

	private static func integer(_ value: Any?) throws -> Int64 {
		guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
			throw ChooserFailure(code: .invalidArgument, detail: "Expected a numeric limit or offset.")
		}
		let size = number.doubleValue
		guard size.isFinite, size >= 0, size <= Double(ChooserFiles.maxSafeInteger), size.rounded(.down) == size else {
			throw ChooserFailure(code: .invalidArgument, detail: "Expected a nonnegative safe integer.")
		}
		return Int64(size)
	}

	@objc(readFile:)
	func readFile(command: CDVInvokedUrlCommand) {
		let reference = ChooserMainReference((self, command))
		ChooserMain.run {
			let (plugin, command) = reference.value
			do {
				guard command.arguments.count == 3, let id = command.arguments[0] as? String else {
					throw ChooserFailure(code: .invalidArgument, detail: "Expected a file id, offset and length.")
				}
				let offset = try Self.integer(command.arguments[1])
				let length = try Self.integer(command.arguments[2])
				guard length <= 262144 else { throw ChooserFailure(code: .invalidArgument, detail: "Read chunk exceeds 262144 bytes.") }
				plugin.read(id: id, offset: offset, length: Int(length), owner: plugin.generation, callback: command.callbackId)
			} catch { plugin.sendFailure(error, callback: command.callbackId, fallback: .readFailed) }
		}
	}

	@objc(cancelRead:)
	func cancelRead(command: CDVInvokedUrlCommand) {
		let reference = ChooserMainReference((self, command))
		ChooserMain.run {
			let (plugin, command) = reference.value
			do {
				guard command.arguments.count == 1, let id = command.arguments.first as? String else {
					throw ChooserFailure(code: .invalidArgument, detail: "Expected a transient source id.")
				}
				try plugin.resources.cancelRead(id: id)
				plugin.send([:], .ok, command.callbackId)
			} catch { plugin.sendFailure(error, callback: command.callbackId) }
		}
	}

	@objc(statFile:)
	func statFile(command: CDVInvokedUrlCommand) {
		resourceCommand(command, releasing: false)
	}

	@objc(releaseFile:)
	func releaseFile(command: CDVInvokedUrlCommand) {
		resourceCommand(command, releasing: true)
	}

	private func resourceCommand(_ command: CDVInvokedUrlCommand, releasing: Bool) {
		let reference = ChooserMainReference((self, command))
		ChooserMain.run {
			let (plugin, command) = reference.value
			do {
				guard command.arguments.count == 1, let id = command.arguments.first as? String else {
					throw ChooserFailure(code: .invalidArgument, detail: "Expected a managed file id.")
				}
				if releasing { try plugin.resources.prepareRelease(id: id) }
				plugin.resource(id: id, releasing: releasing, owner: plugin.generation, callback: command.callbackId)
			} catch { plugin.sendFailure(error, callback: command.callbackId, fallback: releasing ? .releaseFailed : .fileUnavailable) }
		}
	}

	// Construct background callbacks outside the UI actor's lexical context.
	private func read(id: String, offset: Int64, length: Int, owner: UInt64, callback: String) {
		resources.enqueue {
			let result = Result { try self.resources.read(id: id, offset: offset, length: length) }
			self.resourceResult(result, owner: owner, callback: callback, fallback: .readFailed)
		}
	}

	private func resource(id: String, releasing: Bool, owner: UInt64, callback: String) {
		if releasing {
			resources.release(id: id) { result in
				self.resourceResult(result.map { [:] }, owner: owner, callback: callback, fallback: .releaseFailed)
			}
		} else {
			resources.enqueue {
				let result = Result { try self.resources.stat(id: id) }
				self.resourceResult(result, owner: owner, callback: callback, fallback: .fileUnavailable)
			}
		}
	}

	private func resourceResult(_ result: Result<[String: Any], Error>, owner: UInt64, callback: String, fallback: ChooserErrorCode) {
		let reference = ChooserMainReference((self, result))
		ChooserMain.run {
			let (plugin, result) = reference.value
			guard plugin.generation == owner else { return }
			switch result {
			case .success(let object): plugin.send(object, .ok, callback)
			case .failure(let error): plugin.sendFailure(error, callback: callback, fallback: fallback)
			}
		}
	}

	@objc(cancelPick:)
	func cancelPick(command: CDVInvokedUrlCommand) {
		let reference = ChooserMainReference((self, command))
		ChooserMain.run {
			let (plugin, command) = reference.value
			guard command.arguments.count == 1, let id = command.arguments.first as? String, !id.isEmpty else {
				plugin.sendFailure(ChooserFailure(code: .invalidArgument, detail: "Expected a request id."), callback: command.callbackId)
				return
			}
			if let request = plugin.active, request.id == id {
				let selecting = request.state == .selecting
				request.signalCancel(reason: "signal")
				if selecting { plugin.deliver(request, result: .success([:])) }
			}
			plugin.send([:], .ok, command.callbackId)
		}
	}

	private static func cacheDirectory() throws -> URL {
		guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
			throw ChooserFailure(code: .cacheFailed, detail: "Private cache directory is unavailable.")
		}
		return cache
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func begin(_ request: ChooserRequest) {
		guard active == nil, presentation == nil else {
			request.finish()
			sendFailure(ChooserFailure(code: .busy, detail: "A file picker is already active."), callback: request.callback)
			return
		}
		guard let presenter = viewController, presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
			request.finish()
			sendFailure(ChooserFailure(code: .pickerFailed, detail: "The app is not ready to present a file picker."), callback: request.callback)
			return
		}
		let controller: UIViewController
		if request.source == "photos" {
			let photos = PHPickerViewController(configuration: ChooserPhotos.configuration(mediaTypes: request.mediaTypes, multiple: request.multiple, maxFiles: request.maxFiles))
			photos.delegate = self
			controller = photos
		} else {
			let types = ChooserTypes.identifiers(for: request.accept).compactMap { UTType($0) }
			// Import metadata selections for providers that cannot open in place.
			let documents = ChooserDocumentPicker(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: request.mode == .metadata)
			documents.request = request
			documents.delegate = self
			documents.allowsMultipleSelection = request.multiple
			controller = documents
		}
		controller.presentationController?.delegate = self
		if let popover = controller.popoverPresentationController {
			popover.sourceView = presenter.view
			popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
			popover.permittedArrowDirections = []
		}
		active = request
		let presentation = ChooserPresentation(request: request, controller: controller)
		self.presentation = presentation
		presenter.present(controller, animated: true) {
			guard presentation.pending else { return }
			presentation.pending = false
			if self.active === request { controller.presentationController?.delegate = self }
			if presentation.finishing {
				Self.deferMain { self.finishPresentation(presentation) }
			}
		}
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func selected(_ controller: UIDocumentPickerViewController, urls: [URL]) {
		guard let request = (controller as? ChooserDocumentPicker)?.request, active === request, request.process() else { return }
		var seen = Set<URL>()
		var unique: [URL] = []
		for url in urls where seen.insert(url).inserted {
			unique.append(url)
			if !request.multiple { break }
		}
		processDocuments(unique, request: request)
	}

	private func processDocuments(_ urls: [URL], request: ChooserRequest) {
		process(request: request, count: urls.count) { try urls.map { try self.readDocument(url: $0, request: request) } }
	}

	private func processPhotos(_ providers: [NSItemProvider], request: ChooserRequest) {
		process(request: request, count: providers.count) { try self.readPhotos(providers, request: request) }
	}

	private func process(request: ChooserRequest, count: Int, produce: @escaping () throws -> [[String: Any]]) {
		guard let worker = request.worker else { return }
		worker.run {
			let result: Result<Any, Error>
			do {
				try request.checkCanceled()
				if count == 0 { request.signalCancel(reason: "picker"); throw ChooserFailure(code: .cancelled, detail: "Selection canceled.") }
				if request.maxFiles > 0 && Int64(count) > request.maxFiles { throw ChooserFailure(code: .tooManyFiles, detail: "Selection exceeds the file count limit.") }
				if request.mode == .copy || (request.mode == .data && request.source == "photos") {
					request.attach(try ChooserTransaction.begin(in: Self.cacheDirectory()))
				}
				let values = try produce()
				try request.checkCanceled()
				try request.transaction?.commit(canceled: { request.canceled })
				result = .success(request.multiple ? values as Any : values[0] as Any)
			} catch {
				request.recordFailure(error)
				request.finishResources(delivered: false, wait: true)
				result = .failure(error)
			}
			let reference = ChooserMainReference((self, request, result))
			ChooserMain.run {
				let (plugin, request, result) = reference.value
				plugin.deliver(request, result: result)
			}
		}
	}

	private func readDocument(url: URL, request: ChooserRequest) throws -> [String: Any] {
		return try coordinated(url: url, request: request) { coordinated in
			let sizeValues = try? coordinated.resourceValues(forKeys: [.fileSizeKey])
			let reported: Any = sizeValues?.fileSize.flatMap { size -> Int? in
				return size >= 0 && Int64(size) <= ChooserFiles.maxSafeInteger ? size : nil
			}.map { $0 as Any } ?? NSNull()
			var file: [String: Any] = ["name": coordinated.lastPathComponent, "mediaType": ChooserTypes.mediaType(for: coordinated),
				"size": reported, "sourceUri": url.absoluteString]
			if request.mode == .copy { file = try self.copy(coordinated, metadata: file, request: request) }
			else if request.mode == .data {
				let id = try self.resources.register(ChooserSource(url: url, budget: request.budget))
				request.trackSource(id, in: self.resources)
				file["id"] = id; file["kind"] = "source"
			}
			return file
		}
	}

	private func coordinated(url: URL, request: ChooserRequest, consume: (URL) throws -> [String: Any]) throws -> [String: Any] {
		guard url.isFileURL else { throw ChooserFailure(code: .readFailed, detail: "Expected a provider file URL.") }
		let scoped = url.startAccessingSecurityScopedResource()
		defer { if scoped { url.stopAccessingSecurityScopedResource() } }
		let coordinator = NSFileCoordinator()
		request.coordinate(using: coordinator)
		defer { request.coordinate(using: nil) }
		try request.checkCanceled()
		var coordinationError: NSError?
		var result: Result<[String: Any], Error>?
		coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
			result = Result {
				try request.checkCanceled()
				guard try coordinated.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
					throw ChooserFailure(code: .readFailed, detail: "Select a regular file, not a directory or package.")
				}
				return try consume(coordinated)
			}
		}
		if let error = coordinationError { throw error }
		guard let value = result else { throw ChooserFailure(code: .readFailed, detail: "File coordination returned no result.") }
		return try value.get()
	}

	private func copy(_ url: URL, metadata: [String: Any], request: ChooserRequest) throws -> [String: Any] {
		guard let transaction = request.transaction else { throw ChooserFailure(code: .cacheFailed, detail: "Missing copy transaction.") }
		let destination = try transaction.create()
		let count = try copyBytes(from: url, to: destination, budget: request.budget, request: request)
		var file = metadata
		file["uri"] = try transaction.destination(for: destination).absoluteString
		file["id"] = destination.lastPathComponent
		file["size"] = count
		return file
	}

	private func copyBytes(from source: URL, to destination: URL, budget: ChooserBudget, request: ChooserRequest) throws -> Int64 {
		guard let input = InputStream(url: source), let output = OutputStream(url: destination, append: false) else {
			throw ChooserFailure(code: .copyFailed, detail: "Could not open file streams.")
		}
		return try ChooserFiles.copy(input: input, output: output, budget: budget, canceled: { request.canceled })
	}

	private func readPhotos(_ providers: [NSItemProvider], request: ChooserRequest) throws -> [[String: Any]] {
		var values: [[String: Any]] = []
		for provider in providers {
			try request.checkCanceled()
			let identifier = try ChooserPhotos.identifier(for: provider, mediaTypes: request.mediaTypes)
			let metadata = ChooserPhotos.metadata(for: provider, identifier: identifier)
			if request.mode == .metadata { values.append(metadata); continue }
			let value = try ChooserPhotos.load(provider: provider, identifier: identifier, request: request) { temporary in
				return try self.coordinated(url: temporary, request: request) { url in
					if request.mode == .copy { return try self.copy(url, metadata: metadata, request: request) }
					// PHPicker's URL expires when this callback returns. Stage only that
					// provider-required import; all bridge data still uses bounded reads.
					guard let transaction = request.transaction else { throw ChooserFailure(code: .cacheFailed, detail: "Missing photo import transaction.") }
					let cache = try Self.cacheDirectory()
					let staged = try transaction.create()
					let imported = try transaction.destination(for: staged)
					let id = staged.lastPathComponent
					_ = try self.copyBytes(from: url, to: staged, budget: request.importBudget, request: request)
					try request.checkCanceled()
					let source = ChooserSource(url: imported, budget: request.budget, cleanup: { try ChooserFiles.release(in: cache, id: id) })
					_ = try self.resources.register(source, id: id)
					request.trackSource(id, in: self.resources)
					var file = metadata
					file["id"] = id; file["kind"] = "source"
					return file
				}
			}
			values.append(value)
		}
		return values
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func deliver(_ request: ChooserRequest, result: Result<Any, Error>) {
		guard active === request else { request.finishResources(delivered: false); return }
		guard request.complete() else { return }
		var finalized = false
		let finalize: ChooserMainAction = {
			guard !finalized else { return }
			// Claim completion before asynchronous cancellation rollback starts.
			finalized = true
			guard self.active === request else { request.finishResources(delivered: false); return }
			if request.canceled {
				self.rollbackCancellation(request)
				return
			}
			self.active = nil
			defer { request.finish() }
			if let cleanup = request.cleanupError { self.send(cleanup, .error, request.callback); return }
			var delivered = false
			switch result {
			case .success(let object):
				do {
					let bytes = try JSONSerialization.data(withJSONObject: object)
					guard let message = String(data: bytes, encoding: .utf8) else { throw ChooserFailure(code: .readFailed, detail: "Cannot serialize selection.") }
					delivered = self.commandDelegate != nil
					self.commandDelegate?.send(CDVPluginResult(status: .ok, messageAs: message), callbackId: request.callback)
				} catch { self.sendFailure(error, callback: request.callback) }
			case .failure(let error): self.sendFailure(error, callback: request.callback)
			}
			request.finishResources(delivered: delivered)
		}
		if let presentation = presentation, presentation.request === request {
			finishPresentation(presentation, animated: true, completion: finalize)
		} else { finalize() }
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func finishPresentation(_ presentation: ChooserPresentation, animated: Bool, completion: @escaping ChooserMainAction) {
		presentation.animated = animated
		presentation.completion = completion
		// Reset can replace delivery with cleanup without starting another loop.
		guard !presentation.finishing else { return }
		presentation.finishing = true
		finishPresentation(presentation)
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func finishPresentation(_ presentation: ChooserPresentation) {
		guard self.presentation === presentation, !presentation.pending else { return }
		let controller = presentation.controller
		var recheckScheduled = false
		let recheck: ChooserMainAction = {
			guard !recheckScheduled else { return }
			recheckScheduled = true
			// Recheck after UIKit has returned from its completion callback.
			Self.deferMain { self.finishPresentation(presentation) }
		}
		// The system document picker may already be dismissing when its delegate
		// runs. Join that transition instead of completing a second dismissal early.
		if controller.isBeingPresented || controller.isBeingDismissed {
			if let transition = controller.transitionCoordinator,
				transition.animate(alongsideTransition: nil, completion: { _ in recheck() }) { return }
			// A false return can still invoke the callback; share its one-shot wakeup.
			recheck()
			return
		}
		if controller.presentingViewController != nil {
			controller.dismiss(animated: presentation.animated) { recheck() }
		} else {
			self.presentation = nil
			let completion = presentation.completion
			presentation.completion = nil
			completion?()
		}
	}

	private static func deferMain(_ action: @escaping ChooserMainAction) {
		ChooserWork.dispatch(on: .main) { ChooserMain.run(action) }
	}

	private func rollbackCancellation(_ request: ChooserRequest) {
		request.finishResources(delivered: false) {
			let reference = ChooserMainReference((self, request))
			ChooserMain.run {
				let (plugin, request) = reference.value
				guard plugin.active === request else { return }
				plugin.active = nil
				request.finish()
				let canceled: [String: Any] = ["code": "CANCELLED", "reason": request.cancellationReason ?? "signal", "message": "Selection canceled."]
				if var cleanup = request.cleanupError {
					cleanup["cause"] = canceled
					plugin.send(cleanup, .error, request.callback)
				} else { plugin.send(canceled, .error, request.callback) }
			}
		}
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func send(_ object: [String: Any], _ status: CDVCommandStatus, _ callback: String) {
		commandDelegate?.send(CDVPluginResult(status: status, messageAs: object), callbackId: callback)
	}

	#if compiler(>=5.9)
	@MainActor
	#endif
	private func sendFailure(_ error: Error, callback: String, fallback: ChooserErrorCode = .readFailed) {
		let failure = error as? ChooserFailure
		var object: [String: Any] = ["code": (failure?.code ?? fallback).rawValue, "message": failure?.detail ?? error.localizedDescription]
		if failure?.code == .cancelled { object["reason"] = "signal" }
		send(object, .error, callback)
	}

	override func onReset() {
		let reference = ChooserMainReference(self)
		ChooserMain.run {
			let plugin = reference.value
			plugin.generation &+= 1
			let abandoned = plugin.active
			let phase = abandoned?.state
			abandoned?.cancel()
			// A completing request has no remaining provider I/O. Reset must own
			// its rollback even if UIKit drops the pending dismissal completion.
			if phase != .processing { abandoned?.finishResources(delivered: false) }
			plugin.active = nil
			// Retain UI ownership across reset, including UIKit's delayed present.
			// Its captured controller must finish dismissal before another pick.
			if let presentation = plugin.presentation {
				plugin.finishPresentation(presentation, animated: false, completion: {})
			}
			plugin.resources.resetSources()
		}
	}

	override func dispose() { onReset(); super.dispose() }
}

#if compiler(>=5.9)
@MainActor
#endif
extension Chooser: UIDocumentPickerDelegate {
	func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { selected(controller, urls: urls) }
	func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentAt url: URL) { selected(controller, urls: [url]) }
	func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
		guard let request = (controller as? ChooserDocumentPicker)?.request, active === request, request.state == .selecting else { return }
		request.signalCancel(reason: "picker")
		deliver(request, result: .success([:]))
	}
}

#if compiler(>=5.9)
@MainActor
#endif
extension Chooser: PHPickerViewControllerDelegate {
	func picker(_ controller: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
		guard presentation?.controller === controller, let request = active, request.process() else { return }
		var assets = Set<String>()
		var identities = Set<ObjectIdentifier>()
		var providers: [NSItemProvider] = []
		for result in results {
			if let id = result.assetIdentifier, !assets.insert(id).inserted { continue }
			guard identities.insert(ObjectIdentifier(result.itemProvider)).inserted else { continue }
			providers.append(result.itemProvider)
			if !request.multiple { break }
		}
		processPhotos(providers, request: request)
	}
}

#if compiler(>=5.9)
@MainActor
#endif
extension Chooser: UIAdaptivePresentationControllerDelegate {
	func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
		guard presentationController.presentedViewController === presentation?.controller, let request = active, request.state == .selecting else { return }
		request.signalCancel(reason: "picker")
		deliver(request, result: .success([:]))
	}
}
