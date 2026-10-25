import XCTest
import Cordova
import UniformTypeIdentifiers
@testable import ChooserHost

@MainActor
final class ChooserPickerTests: XCTestCase {
    private var window: UIWindow!
    private var presenter: UIViewController!
    private var plugin: Chooser!
    private var sink: FixtureSink!

    override func setUp() {
        super.setUp()
        window = UIWindow(frame: UIScreen.main.bounds)
        presenter = UIViewController()
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        presenter.loadViewIfNeeded()
        sink = FixtureSink()
        plugin = Chooser()
        plugin.viewController = presenter
        plugin.commandDelegate = sink
    }
    override func tearDown() {
        plugin.onReset()
        presenter.dismiss(animated: false)
        window.isHidden = true
        plugin = nil
        sink = nil
        window = nil
        super.tearDown()
    }
    private func waitUntil(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(10)
        while !predicate() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        XCTAssertTrue(predicate(), file: file, line: line)
    }
    private func open(_ callback: String) -> UIDocumentPickerViewController {
        plugin.getFile(command: CDVInvokedUrlCommand(arguments: ["*/*", false], callbackId: callback, className: "Chooser", methodName: "getFile"))
        waitUntil { self.presenter.presentedViewController is UIDocumentPickerViewController }
        return presenter.presentedViewController as! UIDocumentPickerViewController
    }
    private func messages(_ callback: String) -> [CDVPluginResult] {
        sink.results[callback] as? [CDVPluginResult] ?? []
    }
    private func dismiss() {
        presenter.dismiss(animated: false)
        waitUntil { self.presenter.presentedViewController == nil }
    }
    func testAdaptiveDismissalAndStaleCallbacks() {
        let first = open("first")
        XCTAssertTrue(first.presentationController?.delegate === plugin)
        plugin.presentationControllerDidDismiss(first.presentationController!)
        plugin.documentPickerWasCancelled(first)
        XCTAssertEqual(messages("first").count, 1)
        XCTAssertEqual(messages("first")[0].message as? String, "RESULT_CANCELED")
        dismiss()
        let second = open("second")
        plugin.documentPickerWasCancelled(first)
        XCTAssertTrue(messages("second").isEmpty)
        plugin.documentPickerWasCancelled(second)
        XCTAssertEqual(messages("second").count, 1)
    }
    func testResetAndDuplicateSelectionCannotSettleANewerRequest() throws {
        let first = open("reset")
        plugin.onReset()
        waitUntil { self.presenter.presentedViewController == nil }
        let second = open("selected")
        let source = FixtureController.documents.appendingPathComponent("unit.json")
        try Data("{}".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        plugin.documentPicker(first, didPickDocumentsAt: [source])
        XCTAssertTrue(messages("reset").isEmpty)
        plugin.documentPicker(second, didPickDocumentsAt: [source])
        plugin.documentPicker(second, didPickDocumentsAt: [source])
        waitUntil { !self.messages("selected").isEmpty }
        XCTAssertEqual(messages("selected").count, 1)
        let message = messages("selected")[0].message as! String
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
