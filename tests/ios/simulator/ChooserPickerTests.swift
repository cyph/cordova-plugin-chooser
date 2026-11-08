import XCTest
import UIKit
#if canImport(Cordova)
import Cordova
#endif
import UniformTypeIdentifiers
import PhotosUI
@testable import ChooserHost

@MainActor
private final class PickerHarness {
    let window: UIWindow
    let presenter = CDVViewController()
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
        plugin.onReset()
        presenter.dismiss(animated: false)
        window.isHidden = true
    }
    func waitUntil(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(10)
        while !predicate() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        XCTAssertTrue(predicate(), file: file, line: line)
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
    func object(_ callback: String) throws -> [String: Any] {
        waitUntil { !self.messages(callback).isEmpty }
        let message = try XCTUnwrap(messages(callback).first?.message)
        if let object = message as? [String: Any] { return object }
        let text = try XCTUnwrap(message as? String)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    func open(_ callback: String, mode: String = "metadata", multiple: Bool = false, maxFiles: Int64 = 0) -> UIDocumentPickerViewController {
        invoke("pick", [options(callback, mode: mode, multiple: multiple, maxFiles: maxFiles)], callback)
        // UIKit exposes presentedViewController before the presentation
        // completion installs the adaptive-dismissal delegate.
        waitUntil {
            guard let picker = self.presenter.presentedViewController as? UIDocumentPickerViewController else { return false }
            return picker.presentationController?.delegate === self.plugin && !picker.isBeingPresented
        }
        return presenter.presentedViewController as! UIDocumentPickerViewController
    }
    func messages(_ callback: String) -> [CDVPluginResult] {
        sink.results[callback] as? [CDVPluginResult] ?? []
    }
    func dismiss() {
        presenter.dismiss(animated: false)
        waitUntil { self.presenter.presentedViewController == nil }
    }
}

final class ChooserPickerTests: XCTestCase {
    @MainActor
    func testAdaptiveDismissalAndStaleCallbacks() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let plugin = h.plugin
        let first = h.open("first")
        let views = first.view.subviews.map { ObjectIdentifier($0) }
        FixturePresentation().presented(first)
        XCTAssertEqual(first.view.subviews.map { ObjectIdentifier($0) }, views,
                       "Presentation diagnostics must preserve the system picker's view hierarchy")
        XCTAssertTrue(first.presentationController?.delegate === plugin)
        plugin.presentationControllerDidDismiss(first.presentationController!)
        plugin.documentPickerWasCancelled(first)
        let canceled = try h.object("first")
        XCTAssertEqual(h.messages("first").count, 1)
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "picker")
        h.dismiss()
        let second = h.open("second")
        plugin.documentPickerWasCancelled(first)
        XCTAssertTrue(h.messages("second").isEmpty)
        plugin.documentPickerWasCancelled(second)
        _ = try h.object("second")
        XCTAssertEqual(h.messages("second").count, 1)
    }
    @MainActor
    func testResetAndDuplicateSelectionCannotSettleANewerRequest() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let plugin = h.plugin
        let first = h.open("reset")
        plugin.onReset()
        h.waitUntil { h.presenter.presentedViewController == nil }
        let second = h.open("selected")
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-unit-\(UUID().uuidString).json")
        try Data("{}".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        plugin.documentPicker(first, didPickDocumentsAt: [source])
        XCTAssertTrue(h.messages("reset").isEmpty)
        plugin.documentPicker(second, didPickDocumentsAt: [source])
        plugin.documentPicker(second, didPickDocumentsAt: [source])
        h.waitUntil { !h.messages("selected").isEmpty }
        XCTAssertEqual(h.messages("selected").count, 1)
        let message = h.messages("selected")[0].message as! String
        let value = try JSONSerialization.jsonObject(with: Data(message.utf8)) as! [String: Any]
        XCTAssertNil(value["data"])
        XCTAssertNil(value["id"])
        XCTAssertNil(value["uri"])
        XCTAssertEqual(value["sourceUri"] as? String, source.absoluteString)
        XCTAssertEqual(value["size"] as? Int, 2)
    }
    @MainActor
    func testSignalCancellationIdentityAndImmediateReopen() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let blocked = try PickerBlockedSource(store: h.plugin.resources)
        defer { blocked.unblock() }
        blocked.start()
        XCTAssertEqual(blocked.input.entered.wait(timeout: .now() + 5), .success)
        h.plugin.onReset()
        let cache = try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
        let unrelated = try ChooserFiles.create(in: cache)
        defer { try? ChooserFiles.release(in: cache, id: unrelated.lastPathComponent) }
        h.invoke("releaseFile", [unrelated.lastPathComponent], "unrelated-release")
        let released = try h.object("unrelated-release")
        XCTAssertNil(released["code"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: unrelated.path))
        h.invoke("pick", [h.options("signal-first")], "signal-first")
        let first = try XCTUnwrap(h.presenter.presentedViewController as? UIDocumentPickerViewController)
        XCTAssertTrue(first.isBeingPresented, "Exercise AbortSignal cancellation during presentation")
        h.invoke("cancelPick", ["stale-identity"], "stale-cancel")
        _ = try h.object("stale-cancel")
        XCTAssertTrue(h.messages("signal-first").isEmpty)
        h.invoke("cancelPick", ["signal-first"], "cancel-ack")
        h.invoke("cancelPick", ["signal-first"], "duplicate-cancel-ack")
        _ = try h.object("cancel-ack")
        _ = try h.object("duplicate-cancel-ack")
        let canceled = try h.object("signal-first")
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "signal")
        XCTAssertNil(h.presenter.presentedViewController)
        let second = h.open("signal-second")
        h.plugin.documentPickerWasCancelled(first)
        h.invoke("cancelPick", ["signal-first"], "late-cancel")
        _ = try h.object("late-cancel")
        XCTAssertTrue(h.messages("signal-second").isEmpty)
        h.plugin.documentPickerWasCancelled(second)
        _ = try h.object("signal-second")
        XCTAssertEqual(h.messages("signal-first").count, 1)
        XCTAssertEqual(h.messages("signal-second").count, 1)
        XCTAssertEqual(blocked.input.closeCount, 0, "Reset closed the source while native I/O was blocked")
        XCTAssertTrue(FileManager.default.fileExists(atPath: blocked.imported.path))
        blocked.unblock()
        XCTAssertEqual(blocked.finished.wait(timeout: .now() + 5), .success)
        h.waitUntil { blocked.input.closeCount == 1 && !FileManager.default.fileExists(atPath: blocked.imported.path) }
    }

    @MainActor
    func testDirectDataSessionsAreLazyBoundedAndCancelable() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let picker = h.open("source", mode: "data")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bin")
        try Data([1, 2, 3]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        h.plugin.documentPicker(picker, didPickDocumentsAt: [url])
        let selected = try h.object("source")
        XCTAssertEqual(selected["kind"] as? String, "source")
        XCTAssertNil(selected["data"])
        XCTAssertNil(selected["uri"])
        let id = try XCTUnwrap(selected["id"] as? String)
        // A replacement before the first read is visible: no eager data snapshot.
        try Data([8, 9, 10]).write(to: url)
        h.invoke("readFile", [id, 0, 2], "source-read")
        XCTAssertEqual(try h.object("source-read")["data"] as? String, Data([8, 9]).base64EncodedString())
        h.invoke("statFile", [id], "source-stat")
        XCTAssertEqual(try h.object("source-stat")["code"] as? String, "FILE_UNAVAILABLE")
        h.invoke("readFile", [id, 0, 262145], "oversize-read")
        XCTAssertEqual(try h.object("oversize-read")["code"] as? String, "INVALID_ARGUMENT")
        h.invoke("cancelRead", [id], "read-cancel")
        _ = try h.object("read-cancel")
        h.invoke("readFile", [id, 2, 1], "canceled-read")
        XCTAssertEqual(try h.object("canceled-read")["code"] as? String, "CANCELLED")
        h.invoke("releaseFile", [id], "source-release")
        _ = try h.object("source-release")
        XCTAssertEqual(try Data(contentsOf: url), Data([8, 9, 10]))
    }

    @MainActor
    func testManagedCopySurvivesResetAndReadsPositionally() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let picker = h.open("copy", mode: "copy")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bin")
        let bytes = Data((0..<300003).map { UInt8($0 % 251) })
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        h.plugin.documentPicker(picker, didPickDocumentsAt: [url])
        let selected = try h.object("copy")
        let id = try XCTUnwrap(selected["id"] as? String)
        XCTAssertEqual(selected["size"] as? Int, bytes.count)
        h.plugin.onReset()
        h.invoke("statFile", [id], "copy-stat")
        XCTAssertEqual(try h.object("copy-stat")["size"] as? Int, bytes.count)
        h.invoke("cancelRead", [id], "managed-cancel")
        XCTAssertEqual(try h.object("managed-cancel")["code"] as? String, "INVALID_ARGUMENT")
        h.invoke("readFile", [id, 300001, 8], "copy-tail")
        let tail = try h.object("copy-tail")
        XCTAssertEqual(tail["data"] as? String, Data(bytes.suffix(2)).base64EncodedString())
        XCTAssertEqual(tail["eof"] as? Bool, true)
        h.invoke("readFile", [id, 0, 3], "copy-head")
        XCTAssertEqual(try h.object("copy-head")["data"] as? String, Data(bytes.prefix(3)).base64EncodedString())
        h.invoke("releaseFile", [id], "copy-release")
        _ = try h.object("copy-release")
        h.invoke("statFile", [id], "copy-gone")
        XCTAssertEqual(try h.object("copy-gone")["code"] as? String, "FILE_UNAVAILABLE")
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    @MainActor
    func testNativeOptionValidationAndMetadataCountLimit() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let invalid: [[String: Any]] = [["source": "camera"], ["maxFileSize": true], ["maxFiles": -1],
                                      ["maxTotalSize": 1.5], ["multiple": 1], ["requestId": ""]]
        for (index, change) in invalid.enumerated() {
            var options = h.options("invalid-\(index)")
            for (key, value) in change { options[key] = value }
            h.invoke("pick", [options], "invalid-\(index)")
            XCTAssertEqual(try h.object("invalid-\(index)")["code"] as? String, "INVALID_ARGUMENT")
            XCTAssertNil(h.presenter.presentedViewController)
        }
        let picker = h.open("count", multiple: true, maxFiles: 1)
        let urls = ["first", "second"].map { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + $0) }
        for url in urls { try Data([1]).write(to: url) }
        defer { for url in urls { try? FileManager.default.removeItem(at: url) } }
        h.plugin.documentPicker(picker, didPickDocumentsAt: urls)
        XCTAssertEqual(try h.object("count")["code"] as? String, "TOO_MANY_FILES")
    }

    @MainActor
    func testPhotoPickerConfigurationAndCancellation() throws {
        let h = try PickerHarness()
        defer { h.close() }
        let configuration = ChooserPhotos.configuration(mediaTypes: ["image", "video"], multiple: true, maxFiles: 3)
        XCTAssertEqual(configuration.preferredAssetRepresentationMode, .current)
        XCTAssertEqual(configuration.selection, .ordered)
        XCTAssertEqual(configuration.selectionLimit, 3)
        XCTAssertNotNil(configuration.filter)
        h.invoke("pick", [h.options("photos", source: "photos")], "photos")
        let picker = try XCTUnwrap(h.presenter.presentedViewController as? PHPickerViewController)
        XCTAssertTrue(picker.isBeingPresented, "Exercise delegate cancellation during presentation")
        h.plugin.picker(picker, didFinishPicking: [])
        h.plugin.picker(picker, didFinishPicking: [])
        let canceled = try h.object("photos")
        XCTAssertEqual(canceled["code"] as? String, "CANCELLED")
        XCTAssertEqual(canceled["reason"] as? String, "picker")
        XCTAssertNil(h.presenter.presentedViewController)
        XCTAssertEqual(h.messages("photos").count, 1)
        h.invoke("pick", [h.options("photos-reopened", source: "photos")], "photos-reopened")
        let reopened = try XCTUnwrap(h.presenter.presentedViewController as? PHPickerViewController)
        h.plugin.picker(picker, didFinishPicking: [])
        XCTAssertTrue(h.messages("photos-reopened").isEmpty)
        h.plugin.picker(reopened, didFinishPicking: [])
        h.plugin.picker(reopened, didFinishPicking: [])
        XCTAssertEqual(try h.object("photos-reopened")["code"] as? String, "CANCELLED")
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
