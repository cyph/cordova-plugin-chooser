import XCTest
import UIKit
#if canImport(Cordova)
import Cordova
#endif
import UniformTypeIdentifiers
import PhotosUI
@testable import ChooserHost

@MainActor
private final class PickerPresentation {
    let controller: UIViewController
    var started = false
    var completed = false

    init(_ controller: UIViewController) { self.controller = controller }
}

@MainActor
private final class PickerPresenter: CDVViewController {
    var onPresentation: (@MainActor (PickerPresentation) -> Void)?
    var deferNextPresentation = false
    private var deferredPresentation: (() -> Void)?

    override func present(_ controller: UIViewController, animated: Bool, completion: (() -> Void)? = nil) {
        let presentation = PickerPresentation(controller)
        let observe = onPresentation
        onPresentation = nil
        if deferNextPresentation {
            deferNextPresentation = false
            XCTAssertNil(deferredPresentation)
            // Model UIKit accepting a presentation before establishing any
            // controller relationships. Releasing still calls real UIKit.
            deferredPresentation = { [self] in
                presentUsingUIKit(presentation, animated: animated, completion: completion)
            }
        } else {
            presentUsingUIKit(presentation, animated: animated, completion: completion)
        }
        observe?(presentation)
    }
    private func presentUsingUIKit(_ presentation: PickerPresentation, animated: Bool, completion: (() -> Void)?) {
        presentation.started = true
        super.present(presentation.controller, animated: animated) {
            presentation.completed = true
            completion?()
        }
    }
    func resumePresentation() {
        let resume = deferredPresentation
        deferredPresentation = nil
        resume?()
    }
    func clearObservation() {
        onPresentation = nil
        deferredPresentation = nil
    }
}

@MainActor
private final class PickerHarness {
    let window: UIWindow
    let presenter = PickerPresenter()
    let plugin = Chooser()
    let sink = FixtureSink()

    init() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        presenter.startPage = "unit.html"
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        presenter.loadViewIfNeeded()
        plugin.viewController = presenter
        plugin.commandDelegate = sink
    }
    func close() {
        presenter.clearObservation()
        plugin.onReset()
        presenter.dismiss(animated: false)
        window.isHidden = true
    }
    func waitUntilAsync(_ predicate: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !predicate() && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(predicate(), file: file, line: line)
    }
    func waitForSemaphore(_ semaphore: DispatchSemaphore) async -> DispatchTimeoutResult {
        let deadline = DispatchTime.now() + 5
        return await withCheckedContinuation { continuation in
            ChooserWork.dispatch(on: .global()) {
                continuation.resume(returning: semaphore.wait(timeout: deadline))
            }
        }
    }
    func options(_ callback: String, source: String = "documents", mode: String = "metadata", multiple: Bool = false,
                 maxFileSize: Int64 = 0, maxTotalSize: Int64 = 0, maxFiles: Int64 = 0) -> [String: Any] {
        return ["requestId": callback, "source": source, "accept": "*/*", "mode": mode, "multiple": multiple,
                "localOnly": false, "maxFileSize": maxFileSize, "maxTotalSize": maxTotalSize, "maxFiles": maxFiles,
                "mediaTypes": ["image", "video"]]
    }
    func invoke(_ action: String, _ arguments: [Any], _ callback: String) {
        let command: CDVInvokedUrlCommand = CDVInvokedUrlCommand(arguments: arguments, callbackId: callback, className: "Chooser", methodName: action)
        switch action {
        case "pick": plugin.pick(command: command)
        case "readFile": plugin.readFile(command: command)
        case "statFile": plugin.statFile(command: command)
        case "releaseFile": plugin.releaseFile(command: command)
        case "cancelPick": plugin.cancelPick(command: command)
        case "cancelRead": plugin.cancelRead(command: command)
        default: XCTFail("Unknown fixture action")
        }
    }
    func objectAsync(_ callback: String) async throws -> [String: Any] {
        try await waitUntilAsync { !self.messages(callback).isEmpty }
        let message = try XCTUnwrap(messages(callback).first?.message)
        if let object = message as? [String: Any] { return object }
        let text = try XCTUnwrap(message as? String)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    func openAsync(_ callback: String, mode: String = "metadata", multiple: Bool = false,
                   maxFiles: Int64 = 0) async throws -> UIDocumentPickerViewController {
        let presentation = try await duringPresentation(callback, mode: mode, multiple: multiple, maxFiles: maxFiles) { _ in }
        try await waitUntilAsync { presentation.completed }
        let picker = try XCTUnwrap(presentation.controller as? UIDocumentPickerViewController)
        XCTAssertTrue(presenter.presentedViewController === picker)
        XCTAssertTrue(picker.presentationController?.delegate === plugin)
        return picker
    }
    func duringPresentation(_ callback: String, source: String = "documents", mode: String = "metadata",
                            multiple: Bool = false, maxFiles: Int64 = 0, deferred: Bool = false,
                            perform: @escaping @MainActor (PickerPresentation) -> Void) async throws -> PickerPresentation {
        var presented: PickerPresentation?
        presenter.deferNextPresentation = deferred
        presenter.onPresentation = { presentation in
            presented = presentation
            XCTAssertTrue(Thread.isMainThread, "Observe and cancel the UIKit presentation on the main thread")
            XCTAssertFalse(presentation.completed, "Cancel before UIKit's presentation completion")
            perform(presentation)
        }
        defer { presenter.onPresentation = nil }
        invoke("pick", [options(callback, source: source, mode: mode, multiple: multiple, maxFiles: maxFiles)], callback)
        try await waitUntilAsync { presented != nil }
        return try XCTUnwrap(presented)
    }
    func waitForDismissalAsync(_ presentation: PickerPresentation) async throws {
        try await waitUntilAsync {
            presentation.completed && presentation.controller.presentingViewController == nil &&
                !presentation.controller.isBeingPresented && !presentation.controller.isBeingDismissed &&
                self.presenter.presentedViewController == nil
        }
        // UIKit has finished; let the plugin's queued dismissal recheck clear
        // its ownership barrier before a reset test opens another request.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
    func messages(_ callback: String) -> [CDVPluginResult] {
        sink.results[callback] as? [CDVPluginResult] ?? []
    }
    func dismissAsync() async throws {
        guard presenter.presentedViewController != nil else { return }
        var completed = false
        presenter.dismiss(animated: false) { completed = true }
        try await waitUntilAsync { completed }
        XCTAssertNil(presenter.presentedViewController)
    }
}

final class ChooserPickerTests: XCTestCase {
    @MainActor
    func testAdaptiveDismissalAndStaleCallbacks() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let plugin = h.plugin
        let first = try await h.openAsync("first")
        let views = first.view.subviews.map { ObjectIdentifier($0) }
        FixturePresentation().presented(first)
        XCTAssertEqual(first.view.subviews.map { ObjectIdentifier($0) }, views,
                       "Presentation diagnostics must preserve the system picker's view hierarchy")
        XCTAssertTrue(first.presentationController?.delegate === plugin)
        plugin.presentationControllerDidDismiss(first.presentationController!)
        plugin.documentPickerWasCancelled(first)
        let canceled = try await h.objectAsync("first")
        XCTAssertEqual(h.messages("first").count, 1)
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "picker")
        try await h.dismissAsync()
        let second = try await h.openAsync("second")
        plugin.documentPickerWasCancelled(first)
        XCTAssertTrue(h.messages("second").isEmpty)
        plugin.documentPickerWasCancelled(second)
        _ = try await h.objectAsync("second")
        XCTAssertEqual(h.messages("second").count, 1)
    }
    @MainActor
    func testResetAndDuplicateSelectionCannotSettleANewerRequest() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let plugin = h.plugin
        let pending = try await h.duringPresentation("reset", deferred: true) { presentation in
            XCTAssertFalse(presentation.started)
            XCTAssertFalse(presentation.controller.isBeingPresented)
            XCTAssertNil(presentation.controller.presentingViewController)
            plugin.onReset()
        }
        let first = try XCTUnwrap(pending.controller as? UIDocumentPickerViewController)
        h.invoke("pick", [h.options("reset-pending")], "reset-pending")
        let busy = try await h.objectAsync("reset-pending")
        XCTAssertEqual(busy["code"] as? String, "BUSY", "Reset must retain ownership of pending UIKit presentation")
        XCTAssertFalse(pending.completed)
        XCTAssertTrue(h.messages("reset").isEmpty)
        h.presenter.resumePresentation()
        try await h.waitForDismissalAsync(pending)
        XCTAssertTrue(h.messages("reset").isEmpty)
        let second = try await h.openAsync("selected")
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-unit-\(UUID().uuidString).json")
        try Data("{}".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        plugin.documentPicker(first, didPickDocumentsAt: [source])
        plugin.documentPickerWasCancelled(first)
        XCTAssertTrue(h.messages("reset").isEmpty)
        XCTAssertTrue(h.messages("selected").isEmpty)
        XCTAssertTrue(h.presenter.presentedViewController === second)
        plugin.documentPicker(second, didPickDocumentsAt: [source])
        plugin.documentPicker(second, didPickDocumentsAt: [source])
        try await h.waitUntilAsync { !h.messages("selected").isEmpty }
        XCTAssertEqual(h.messages("selected").count, 1)
        let message = h.messages("selected")[0].message as! String
        let value = try JSONSerialization.jsonObject(with: Data(message.utf8)) as! [String: Any]
        XCTAssertNil(value["data"])
        XCTAssertNil(value["id"])
        XCTAssertNil(value["uri"])
        XCTAssertEqual(value["sourceUri"] as? String, source.absoluteString)
        XCTAssertEqual(value["size"] as? Int, 2)
        XCTAssertTrue(h.messages("reset").isEmpty)
    }
    @MainActor
    func testSignalCancellationIdentityAndImmediateReopen() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let blocked = try PickerBlockedSource(store: h.plugin.resources)
        defer { blocked.unblock() }
        blocked.start()
        let entered = await h.waitForSemaphore(blocked.input.entered)
        XCTAssertEqual(entered, .success)
        h.plugin.onReset()
        let cache = try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
        let unrelated = try ChooserFiles.create(in: cache)
        defer { try? ChooserFiles.release(in: cache, id: unrelated.lastPathComponent) }
        h.invoke("releaseFile", [unrelated.lastPathComponent], "unrelated-release")
        let released = try await h.objectAsync("unrelated-release")
        XCTAssertNil(released["code"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: unrelated.path))
        let pending = try await h.duringPresentation("signal-first", deferred: true) { presentation in
            XCTAssertFalse(presentation.started)
            XCTAssertFalse(presentation.controller.isBeingPresented)
            XCTAssertNil(presentation.controller.presentingViewController)
            h.invoke("cancelPick", ["stale-identity"], "stale-cancel")
            XCTAssertTrue(h.messages("signal-first").isEmpty)
            h.invoke("cancelPick", ["signal-first"], "cancel-ack")
            h.invoke("cancelPick", ["signal-first"], "duplicate-cancel-ack")
        }
        _ = try await h.objectAsync("stale-cancel")
        _ = try await h.objectAsync("cancel-ack")
        _ = try await h.objectAsync("duplicate-cancel-ack")
        h.invoke("pick", [h.options("signal-pending")], "signal-pending")
        let busy = try await h.objectAsync("signal-pending")
        XCTAssertEqual(busy["code"] as? String, "BUSY")
        XCTAssertTrue(h.messages("signal-first").isEmpty, "Cancellation must not settle before UIKit completion")
        XCTAssertFalse(pending.completed)
        h.presenter.resumePresentation()
        let canceled = try await h.objectAsync("signal-first")
        XCTAssertTrue(pending.completed)
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "signal")
        XCTAssertNil(h.presenter.presentedViewController)
        let first = try XCTUnwrap(pending.controller as? UIDocumentPickerViewController)
        let reopened = try await h.duringPresentation("signal-second") { presentation in
            XCTAssertTrue(presentation.started, "Exercise cancellation immediately after real present returns")
            h.plugin.documentPickerWasCancelled(first)
            h.invoke("cancelPick", ["signal-first"], "late-cancel")
            XCTAssertTrue(h.messages("signal-second").isEmpty)
            h.invoke("cancelPick", ["signal-second"], "reopened-cancel")
        }
        _ = try await h.objectAsync("late-cancel")
        _ = try await h.objectAsync("reopened-cancel")
        let secondCanceled = try await h.objectAsync("signal-second")
        XCTAssertEqual(secondCanceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(secondCanceled["reason"] as? String, "signal")
        XCTAssertTrue(reopened.completed)
        XCTAssertNil(h.presenter.presentedViewController)
        XCTAssertEqual(h.messages("signal-first").count, 1)
        XCTAssertEqual(h.messages("signal-second").count, 1)
        XCTAssertEqual(blocked.input.closeCount, 0, "Reset closed the source while native I/O was blocked")
        XCTAssertTrue(FileManager.default.fileExists(atPath: blocked.imported.path))
        blocked.unblock()
        let finished = await h.waitForSemaphore(blocked.finished)
        XCTAssertEqual(finished, .success)
        try await h.waitUntilAsync { blocked.input.closeCount == 1 && !FileManager.default.fileExists(atPath: blocked.imported.path) }
    }

    @MainActor
    func testDirectDataSessionsAreLazyBoundedAndCancelable() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let picker = try await h.openAsync("source", mode: "data")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bin")
        try Data([1, 2, 3]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        h.plugin.documentPicker(picker, didPickDocumentsAt: [url])
        let selected = try await h.objectAsync("source")
        XCTAssertEqual(selected["kind"] as? String, "source")
        XCTAssertNil(selected["data"])
        XCTAssertNil(selected["uri"])
        let id = try XCTUnwrap(selected["id"] as? String)
        // A replacement before the first read is visible: no eager data snapshot.
        try Data([8, 9, 10]).write(to: url)
        h.invoke("readFile", [id, 0, 2], "source-read")
        let read = try await h.objectAsync("source-read")
        XCTAssertEqual(read["data"] as? String, Data([8, 9]).base64EncodedString())
        h.invoke("statFile", [id], "source-stat")
        let stat = try await h.objectAsync("source-stat")
        XCTAssertEqual(stat["code"] as? String, "FILE_UNAVAILABLE")
        h.invoke("readFile", [id, 0, 262145], "oversize-read")
        let oversize = try await h.objectAsync("oversize-read")
        XCTAssertEqual(oversize["code"] as? String, "INVALID_ARGUMENT")
        h.invoke("cancelRead", [id], "read-cancel")
        _ = try await h.objectAsync("read-cancel")
        h.invoke("readFile", [id, 2, 1], "canceled-read")
        let canceled = try await h.objectAsync("canceled-read")
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        h.invoke("releaseFile", [id], "source-release")
        _ = try await h.objectAsync("source-release")
        XCTAssertEqual(try Data(contentsOf: url), Data([8, 9, 10]))
    }

    @MainActor
    func testManagedCopySurvivesResetAndReadsPositionally() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let picker = try await h.openAsync("copy", mode: "copy")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bin")
        let bytes = Data((0..<300003).map { UInt8($0 % 251) })
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        h.plugin.documentPicker(picker, didPickDocumentsAt: [url])
        let selected = try await h.objectAsync("copy")
        let id = try XCTUnwrap(selected["id"] as? String)
        XCTAssertEqual(selected["size"] as? Int, bytes.count)
        h.plugin.onReset()
        h.invoke("statFile", [id], "copy-stat")
        let stat = try await h.objectAsync("copy-stat")
        XCTAssertEqual(stat["size"] as? Int, bytes.count)
        h.invoke("cancelRead", [id], "managed-cancel")
        let canceled = try await h.objectAsync("managed-cancel")
        XCTAssertEqual(canceled["code"] as? String, "INVALID_ARGUMENT")
        h.invoke("readFile", [id, 300001, 8], "copy-tail")
        let tail = try await h.objectAsync("copy-tail")
        XCTAssertEqual(tail["data"] as? String, Data(bytes.suffix(2)).base64EncodedString())
        XCTAssertEqual(tail["eof"] as? Bool, true)
        h.invoke("readFile", [id, 0, 3], "copy-head")
        let head = try await h.objectAsync("copy-head")
        XCTAssertEqual(head["data"] as? String, Data(bytes.prefix(3)).base64EncodedString())
        h.invoke("releaseFile", [id], "copy-release")
        _ = try await h.objectAsync("copy-release")
        h.invoke("statFile", [id], "copy-gone")
        let gone = try await h.objectAsync("copy-gone")
        XCTAssertEqual(gone["code"] as? String, "FILE_UNAVAILABLE")
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    @MainActor
    func testNativeOptionValidationAndMetadataCountLimit() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let invalid: [[String: Any]] = [["source": "camera"], ["maxFileSize": true], ["maxFiles": -1],
                                      ["maxTotalSize": 1.5], ["multiple": 1], ["requestId": ""]]
        for (index, change) in invalid.enumerated() {
            var options = h.options("invalid-\(index)")
            for (key, value) in change { options[key] = value }
            h.invoke("pick", [options], "invalid-\(index)")
            let invalid = try await h.objectAsync("invalid-\(index)")
            XCTAssertEqual(invalid["code"] as? String, "INVALID_ARGUMENT")
            XCTAssertNil(h.presenter.presentedViewController)
        }
        let picker = try await h.openAsync("count", multiple: true, maxFiles: 1)
        let urls = ["first", "second"].map { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + $0) }
        for url in urls { try Data([1]).write(to: url) }
        defer { for url in urls { try? FileManager.default.removeItem(at: url) } }
        h.plugin.documentPicker(picker, didPickDocumentsAt: urls)
        let limited = try await h.objectAsync("count")
        XCTAssertEqual(limited["code"] as? String, "TOO_MANY_FILES")
    }

    @MainActor
    func testPhotoPickerConfigurationAndCancellation() async throws {
        let h = try PickerHarness()
        defer { h.close() }
        let configuration = ChooserPhotos.configuration(mediaTypes: ["image", "video"], multiple: true, maxFiles: 3)
        XCTAssertEqual(configuration.preferredAssetRepresentationMode, .current)
        XCTAssertEqual(configuration.selection, .ordered)
        XCTAssertEqual(configuration.selectionLimit, 3)
        XCTAssertNotNil(configuration.filter)
        let pending = try await h.duringPresentation("photos", source: "photos", deferred: true) { presentation in
            XCTAssertFalse(presentation.started)
            XCTAssertFalse(presentation.controller.isBeingPresented)
            XCTAssertNil(presentation.controller.presentingViewController)
            guard let picker = presentation.controller as? PHPickerViewController else { XCTFail("Expected photo picker"); return }
            h.plugin.picker(picker, didFinishPicking: [])
            h.plugin.picker(picker, didFinishPicking: [])
        }
        let picker = try XCTUnwrap(pending.controller as? PHPickerViewController)
        h.invoke("pick", [h.options("photos-pending", source: "photos")], "photos-pending")
        let busy = try await h.objectAsync("photos-pending")
        XCTAssertEqual(busy["code"] as? String, "BUSY")
        XCTAssertFalse(pending.completed)
        XCTAssertTrue(h.messages("photos").isEmpty, "Photo cancellation must wait for UIKit completion")
        h.presenter.resumePresentation()
        let canceled = try await h.objectAsync("photos")
        XCTAssertTrue(pending.completed)
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "picker")
        XCTAssertNil(h.presenter.presentedViewController)
        XCTAssertEqual(h.messages("photos").count, 1)
        let reopenedPresentation = try await h.duringPresentation("photos-reopened", source: "photos") { presentation in
            XCTAssertTrue(presentation.started, "Reopen through an ordinary UIKit presentation")
            guard let reopened = presentation.controller as? PHPickerViewController else { XCTFail("Expected photo picker"); return }
            h.plugin.picker(picker, didFinishPicking: [])
            XCTAssertTrue(h.messages("photos-reopened").isEmpty)
            h.plugin.picker(reopened, didFinishPicking: [])
            h.plugin.picker(reopened, didFinishPicking: [])
        }
        let reopenedCanceled = try await h.objectAsync("photos-reopened")
        XCTAssertTrue(reopenedPresentation.completed)
        XCTAssertEqual(reopenedCanceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(reopenedCanceled["reason"] as? String, "picker")
        XCTAssertNil(h.presenter.presentedViewController)
        XCTAssertEqual(h.messages("photos").count, 1)
        XCTAssertEqual(h.messages("photos-reopened").count, 1)
    }

    func testPhotoMetadataDoesNotLoadContentsAndProviderURLIsConsumedInHandler() throws {
        let provider = NSItemProvider()
        provider.suggestedName = "sample"
        let original = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        let retained = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try Data([0, 1, 2, 3]).write(to: original)
        defer { try? FileManager.default.removeItem(at: original); try? FileManager.default.removeItem(at: retained) }
        let loads = PhotoLoadCounter()
        provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { completion in
            loads.increment()
            completion(original, false, nil)
            return nil
        }
        let identifier = try ChooserPhotos.identifier(for: provider, mediaTypes: ["image", "video"])
        let metadata = ChooserPhotos.metadata(for: provider, identifier: identifier)
        XCTAssertEqual(metadata["name"] as? String, "sample.png")
        XCTAssertEqual(metadata["mediaType"] as? String, "image/png")
        XCTAssertTrue(metadata["size"] is NSNull)
        XCTAssertEqual(loads.value, 0)
        XCTAssertThrowsError(try ChooserPhotos.identifier(for: provider, mediaTypes: ["video"]))
        let request = ChooserRequest(callback: "import", accept: "*/*", mode: .data, multiple: false, limit: 0)
        let finished = expectation(description: "provider representation staged")
        ChooserWork.dispatch(on: .global()) {
            do {
                let result = try ChooserPhotos.load(provider: provider, identifier: identifier, request: request) { url in
                    // This runs inside the NSItemProvider completion, while its URL is valid.
                    try FileManager.default.copyItem(at: url, to: retained)
                    return ["copied": true]
                }
                XCTAssertEqual(result["copied"] as? Bool, true)
            } catch { XCTFail("Representation staging failed: \(error)") }
            finished.fulfill()
        }
        wait(for: [finished], timeout: 10)
        try FileManager.default.removeItem(at: original)
        XCTAssertEqual(try Data(contentsOf: retained), Data([0, 1, 2, 3]))
        XCTAssertEqual(loads.value, 1)
    }

    func testMovieWildcardIncludesMP4AndQuickTime() {
        let identifiers = ChooserTypes.identifiers(for: "video/*")
        XCTAssertEqual(identifiers, [UTType.movie.identifier])
        let movie = UTType(identifiers[0])!
        XCTAssertTrue(UTType.mpeg4Movie.conforms(to: movie))
        XCTAssertTrue(UTType.quickTimeMovie.conforms(to: movie))
        XCTAssertEqual(ChooserTypes.identifiers(for: "application/json"), [UTType.json.identifier])
        XCTAssertEqual(ChooserTypes.identifiers(for: "text/csv"), [UTType.commaSeparatedText.identifier])
    }
}

private final class PhotoLoadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

// Construct the background read outside the main actor used by the picker test.
private final class PickerBlockedSource {
    let input: PickerBlockingInput
    let imported: URL
    let finished = DispatchSemaphore(value: 0)
    private let store: ChooserResources
    private let id: String
    init(store: ChooserResources) throws {
        self.store = store
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-blocked-" + UUID().uuidString)
        let stream = PickerBlockingInput(bytes: Data([42]))
        imported = file
        input = stream
        try Data([42]).write(to: file)
        id = try store.register(ChooserSource(url: file, budget: ChooserBudget(fileLimit: 0, totalLimit: 0), cleanup: {
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }, makeStream: { _ in stream }))
    }
    func start() {
        ChooserWork.dispatch(on: .global()) {
            _ = try? self.store.read(id: self.id, offset: 0, length: 1)
            self.finished.signal()
        }
    }
    func unblock() { input.resume.signal() }
}

private final class PickerBlockingInput: InputStream {
    let entered = DispatchSemaphore(value: 0)
    let resume = DispatchSemaphore(value: 0)
    private let backing: InputStream
    private let lock = NSLock()
    private var closed = 0
    init(bytes: Data) {
        backing = InputStream(data: bytes)
        // Delegate to a concrete stream instead of InputStream's abstract methods.
        super.init(data: Data())
    }
    override var streamStatus: Stream.Status { backing.streamStatus }
    override var streamError: Error? { backing.streamError }
    override var hasBytesAvailable: Bool { backing.hasBytesAvailable }
    override func open() { backing.open() }
    override func read(_ buffer: UnsafeMutablePointer<UInt8>, maxLength length: Int) -> Int {
        entered.signal()
        resume.wait()
        return backing.read(buffer, maxLength: length)
    }
    override func getBuffer(_ buffer: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, length len: UnsafeMutablePointer<Int>) -> Bool {
        return backing.getBuffer(buffer, length: len)
    }
    override func close() {
        lock.lock(); closed += 1; lock.unlock()
        backing.close()
    }
    var closeCount: Int { lock.lock(); defer { lock.unlock() }; return closed }
}
