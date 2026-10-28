import XCTest
import UIKit
#if canImport(Cordova)
import Cordova
#endif
import UniformTypeIdentifiers
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
    func open(_ callback: String) -> UIDocumentPickerViewController {
        plugin.getFile(command: CDVInvokedUrlCommand(arguments: ["*/*", false], callbackId: callback, className: "Chooser", methodName: "getFile"))
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
        XCTAssertEqual(h.messages("first").count, 1)
        XCTAssertEqual(h.messages("first")[0].message as? String, "RESULT_CANCELED")
        h.dismiss()
        let second = h.open("second")
        plugin.documentPickerWasCancelled(first)
        XCTAssertTrue(h.messages("second").isEmpty)
        plugin.documentPickerWasCancelled(second)
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
        XCTAssertEqual(value["size"] as? Int, 2)
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
