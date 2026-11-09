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
    private(set) var hasAppeared = false

    // Intentional native-only test double: retain CDVPlugin's CDVViewController
    // ABI while using a real UIView and ordinary UIKit presentation/dismissal.
    override func loadView() { view = UIView() }
    override func viewDidLoad() {
        // Bypass Cordova's WebView, launch screen and startup plugins.
    }
    // Keep the native orientation mask independent of Cordova's settings.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hasAppeared = true
    }
    override func viewWillDisappear(_ animated: Bool) {
        hasAppeared = false
        super.viewWillDisappear(animated)
    }

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

private enum PickerWaitError: Error {
    case timedOut
}

@MainActor
private final class PickerHarness {
    let window: UIWindow
    let presenter = PickerPresenter()
    let plugin = Chooser()
    let sink = FixtureSink()
    private(set) var isObservingResult = false

    init() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        presenter.loadViewIfNeeded()
        plugin.viewController = presenter
        plugin.commandDelegate = sink
        // Wait once for initial UIKit readiness. Later picks must exercise the
        // plugin's readiness at dispatch time, including inside result delivery.
        do {
            try await waitUntilAsync {
                self.presenter.hasAppeared && self.presenter.viewIfLoaded?.window === self.window &&
                    self.window.isKeyWindow && !self.window.isHidden && self.window.alpha > 0 &&
                    self.window.windowScene?.activationState == .foregroundActive &&
                    self.presenter.presentedViewController == nil && self.presenter.transitionCoordinator == nil
            }
        } catch {
            close()
            throw error
        }
    }
    func close() {
        sink.resultObserver = nil
        presenter.clearObservation()
        plugin.onReset()
        presenter.dismiss(animated: false)
        window.isHidden = true
    }
    func waitUntilAsync(_ predicate: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !predicate() && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        let satisfied = predicate()
        XCTAssertTrue(satisfied, "Native picker fixture predicate timed out after 10 seconds", file: file, line: line)
        guard satisfied else { throw PickerWaitError.timedOut }
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
        dispatchPresentation(callback, source: source, mode: mode, multiple: multiple, maxFiles: maxFiles, deferred: deferred) { presentation in
            presented = presentation
            perform(presentation)
        }
        try await waitUntilAsync { presented != nil }
        return try XCTUnwrap(presented)
    }
    // Synchronous dispatch is separate from async observation: result observers
    // must enter the next UIKit presentation before their own call stack returns.
    func dispatchPresentation(_ callback: String, source: String = "documents", mode: String = "metadata",
                              multiple: Bool = false, maxFiles: Int64 = 0, deferred: Bool = false,
                              perform: @escaping @MainActor (PickerPresentation) -> Void) {
        XCTAssertNil(presenter.onPresentation)
        presenter.deferNextPresentation = deferred
        presenter.onPresentation = { presentation in
            XCTAssertTrue(Thread.isMainThread, "Observe and cancel the UIKit presentation on the main thread")
            XCTAssertFalse(presentation.completed, "Cancel before UIKit's presentation completion")
            perform(presentation)
        }
        invoke("pick", [options(callback, source: source, mode: mode, multiple: multiple, maxFiles: maxFiles)], callback)
    }
    func observeResult(_ callback: String, perform: @escaping @MainActor () -> Void) {
        XCTAssertNil(sink.resultObserver)
        sink.resultObserver = { [weak self] observed, _ in
            // The Objective-C sink asserts main-thread delivery. This checked,
            // synchronous actor bridge also works below iOS 17; it never queues.
            ChooserMain.invokeLegacy {
                guard let self = self, observed == callback else { return }
                // One shot: nested acknowledgments/results cannot run this action
                // again, and teardown can release captures even on timeout.
                self.sink.resultObserver = nil
                XCTAssertEqual(self.messages(callback).count, 1, "Record the result before observing it")
                XCTAssertFalse(self.isObservingResult)
                self.isObservingResult = true
                defer { self.isObservingResult = false }
                perform()
            }
        }
    }
    func assertFinishedPresentation(_ presentation: PickerPresentation, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(presentation.started, file: file, line: line)
        XCTAssertTrue(presentation.completed, "Result delivery must follow presentation completion", file: file, line: line)
        XCTAssertNil(presentation.controller.presentingViewController, file: file, line: line)
        XCTAssertFalse(presentation.controller.isBeingPresented, file: file, line: line)
        XCTAssertFalse(presentation.controller.isBeingDismissed, file: file, line: line)
        XCTAssertNil(presentation.controller.transitionCoordinator, file: file, line: line)
        XCTAssertNil(presenter.presentedViewController, "Reopen without an existing modal", file: file, line: line)
        XCTAssertNil(presenter.transitionCoordinator, "Reopen without an existing transition", file: file, line: line)
    }
    func assertSelectingRequest(_ expectedRequest: ChooserRequest?, callback: String, marker: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNotNil(expectedRequest, "\(marker): Expected an active request", file: file, line: line)
        XCTAssertTrue(plugin.active === expectedRequest, "\(marker): Active request identity changed", file: file, line: line)
        XCTAssertEqual(expectedRequest?.callback, callback, "\(marker): Incorrect callback", file: file, line: line)
        XCTAssertEqual(expectedRequest?.id, callback, "\(marker): Incorrect request id", file: file, line: line)
        XCTAssertEqual(expectedRequest?.state, .selecting, "\(marker): Request is no longer selecting", file: file, line: line)
        XCTAssertEqual(expectedRequest?.canceled, false, "\(marker): Request was canceled", file: file, line: line)
        XCTAssertNil(expectedRequest?.cancellationReason, "\(marker): Request has a cancellation reason", file: file, line: line)
    }
    func assertStaleEventIgnored(_ callback: String, marker: String,
                                file: StaticString = #filePath, line: UInt = #line,
                                perform: @MainActor () -> Void) {
        let expectedRequest = plugin.active
        let callbackCount = messages(callback).count
        assertSelectingRequest(expectedRequest, callback: callback, marker: marker, file: file, line: line)
        perform()
        // UIKit may still block result delivery after a stale event has already
        // mutated the request. Inspect it now, without yielding to queued work.
        assertSelectingRequest(expectedRequest, callback: callback, marker: marker, file: file, line: line)
        XCTAssertEqual(messages(callback).count, callbackCount, "\(marker): Callback count changed", file: file, line: line)
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
}

final class ChooserPickerTests: XCTestCase {
    @MainActor
    func testAdaptiveDismissalAndStaleCallbacks() async throws {
        let h = try await PickerHarness()
        defer { h.close() }
        let plugin = h.plugin
        let firstPresentation = try await h.duringPresentation("first") { _ in }
        try await h.waitUntilAsync { firstPresentation.completed }
        let first = try XCTUnwrap(firstPresentation.controller as? UIDocumentPickerViewController)
        XCTAssertTrue(h.presenter.presentedViewController === first)
        let views = first.view.subviews.map { ObjectIdentifier($0) }
        FixturePresentation().presented(first)
        XCTAssertEqual(first.view.subviews.map { ObjectIdentifier($0) }, views,
                       "Presentation diagnostics must preserve the system picker's view hierarchy")
        XCTAssertTrue(first.presentationController?.delegate === plugin)
        let adaptive = try XCTUnwrap(first.presentationController)
        var reopened: PickerPresentation?
        h.observeResult("first") {
            h.assertFinishedPresentation(firstPresentation)
            h.dispatchPresentation("second") { presentation in
                XCTAssertTrue(h.isObservingResult, "Start the next presentation inside cancellation result delivery")
                XCTAssertTrue(presentation.started)
                reopened = presentation
                h.assertStaleEventIgnored("second", marker: "CHOOSER_STALE_EVENT:adaptive") {
                    plugin.presentationControllerDidDismiss(adaptive)
                }
                h.assertStaleEventIgnored("second", marker: "CHOOSER_STALE_EVENT:adaptive") {
                    plugin.documentPickerWasCancelled(first)
                }
                XCTAssertTrue(h.messages("second").isEmpty)
                guard let second = presentation.controller as? UIDocumentPickerViewController else {
                    XCTFail("Expected document picker"); return
                }
                plugin.documentPickerWasCancelled(second)
                plugin.documentPickerWasCancelled(second)
            }
            XCTAssertNotNil(reopened, "The next presentation must start before the result observer returns")
        }
        plugin.presentationControllerDidDismiss(adaptive)
        plugin.documentPickerWasCancelled(first)
        let canceled = try await h.objectAsync("first")
        XCTAssertEqual(h.messages("first").count, 1)
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "picker")
        let secondPresentation = try XCTUnwrap(reopened)
        let secondCanceled = try await h.objectAsync("second")
        h.assertFinishedPresentation(secondPresentation)
        XCTAssertEqual(secondCanceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(secondCanceled["reason"] as? String, "picker")
        XCTAssertFalse(h.isObservingResult)
        XCTAssertEqual(h.messages("first").count, 1)
        XCTAssertEqual(h.messages("second").count, 1)
    }
    @MainActor
    func testResetAndDuplicateSelectionCannotSettleANewerRequest() async throws {
        let h = try await PickerHarness()
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
        let h = try await PickerHarness()
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
            h.assertStaleEventIgnored("signal-first", marker: "CHOOSER_STALE_EVENT:request-id") {
                h.invoke("cancelPick", ["stale-identity"], "stale-cancel")
            }
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
        let first = try XCTUnwrap(pending.controller as? UIDocumentPickerViewController)
        var reopened: PickerPresentation?
        h.observeResult("signal-first") {
            h.assertFinishedPresentation(pending)
            h.dispatchPresentation("signal-second") { presentation in
                XCTAssertTrue(h.isObservingResult, "Start the next presentation inside cancellation result delivery")
                XCTAssertTrue(presentation.started, "Exercise cancellation immediately after real present returns")
                reopened = presentation
                h.assertStaleEventIgnored("signal-second", marker: "CHOOSER_STALE_EVENT:adaptive") {
                    h.plugin.documentPickerWasCancelled(first)
                }
                h.assertStaleEventIgnored("signal-second", marker: "CHOOSER_STALE_EVENT:request-id") {
                    h.invoke("cancelPick", ["signal-first"], "late-cancel")
                }
                XCTAssertTrue(h.messages("signal-second").isEmpty)
                h.invoke("cancelPick", ["signal-second"], "reopened-cancel")
            }
            XCTAssertNotNil(reopened, "The next presentation must start before the result observer returns")
        }
        h.presenter.resumePresentation()
        let canceled = try await h.objectAsync("signal-first")
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "signal")
        let reopenedPresentation = try XCTUnwrap(reopened)
        _ = try await h.objectAsync("late-cancel")
        _ = try await h.objectAsync("reopened-cancel")
        let secondCanceled = try await h.objectAsync("signal-second")
        XCTAssertEqual(secondCanceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(secondCanceled["reason"] as? String, "signal")
        h.assertFinishedPresentation(reopenedPresentation)
        XCTAssertFalse(h.isObservingResult)
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
        let h = try await PickerHarness()
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
        let h = try await PickerHarness()
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
        let h = try await PickerHarness()
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
        let h = try await PickerHarness()
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
        var reopenedPresentation: PickerPresentation?
        h.observeResult("photos") {
            h.assertFinishedPresentation(pending)
            h.dispatchPresentation("photos-reopened", source: "photos") { presentation in
                XCTAssertTrue(h.isObservingResult, "Start the next presentation inside cancellation result delivery")
                XCTAssertTrue(presentation.started, "Reopen through an ordinary UIKit presentation")
                reopenedPresentation = presentation
                guard let reopened = presentation.controller as? PHPickerViewController else { XCTFail("Expected photo picker"); return }
                h.assertStaleEventIgnored("photos-reopened", marker: "CHOOSER_STALE_EVENT:photos") {
                    h.plugin.picker(picker, didFinishPicking: [])
                }
                XCTAssertTrue(h.messages("photos-reopened").isEmpty)
                h.plugin.picker(reopened, didFinishPicking: [])
                h.plugin.picker(reopened, didFinishPicking: [])
            }
            XCTAssertNotNil(reopenedPresentation, "The next presentation must start before the result observer returns")
        }
        h.presenter.resumePresentation()
        let canceled = try await h.objectAsync("photos")
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "picker")
        let reopened = try XCTUnwrap(reopenedPresentation)
        let reopenedCanceled = try await h.objectAsync("photos-reopened")
        h.assertFinishedPresentation(reopened)
        XCTAssertEqual(reopenedCanceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(reopenedCanceled["reason"] as? String, "picker")
        XCTAssertFalse(h.isObservingResult)
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
