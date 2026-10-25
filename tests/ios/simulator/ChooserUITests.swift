import XCTest

final class ChooserUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }
    override func tearDown() {
        if let run = testRun, run.failureCount > 0 {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.lifetime = .keepAlways
            add(screenshot)
        }
        super.tearDown()
    }
    private func launch(sheet: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CHOOSER_TEST_SHEET"] = sheet ? "1" : "0"
        app.launch()
        XCTAssertTrue(app.staticTexts["Outcome"].waitForExistence(timeout: 20))
        expect(app, "ready")
        return app
    }
    private func expect(_ app: XCUIApplication, _ text: String) {
        let predicate = NSPredicate(format: "label == %@", text)
        expectation(for: predicate, evaluatedWith: app.staticTexts["Outcome"])
        waitForExpectations(timeout: 30)
    }
    private func cancel(_ app: XCUIApplication) {
        let button = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
    }
    func testCancelAndImmediateReopen() {
        let app = launch()
        for count in 1...3 {
            app.buttons["Choose"].tap()
            cancel(app)
            expect(app, "canceled:\(count)")
        }
    }
    func testSwipeSheetSettlesOnceAndReopens() {
        let app = launch(sheet: true)
        app.buttons["Choose"].tap()
        let cancelButton = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancelButton.waitForExistence(timeout: 15))
        // Drag the sheet by its top edge, avoiding a scrollable file listing.
        let top = cancelButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
        top.press(forDuration: 0.1, thenDragTo: top.withOffset(CGVector(dx: 0, dy: 650)))
        expect(app, "canceled:1")
        app.buttons["Choose"].tap()
        cancel(app)
        expect(app, "canceled:2")
    }
    func testLocalFilesAndVideoWildcard() {
        let app = launch()
        app.terminate()
        app.launch()
        expect(app, "ready")
        for (button, filename) in [("JSON", "fixture-json.json"), ("CSV", "fixture-csv.csv"),
                                    ("PDF", "fixture-pdf.pdf"), ("Image", "fixture-image.png"),
                                    ("Video", "fixture-mp4.mp4"), ("Video", "fixture-mov.mov")] {
            app.buttons[button].tap()
            // The real Files UI may display extensions or hide registered ones.
            let stem = (filename as NSString).deletingPathExtension
            let item = app.cells.containing(NSPredicate(
                format: "label == %@ OR label == %@", filename, stem)).firstMatch
            XCTAssertTrue(item.waitForExistence(timeout: 20), "Missing local fixture \(filename)")
            XCTAssertTrue(item.isEnabled)
            let interactive = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                item.exists && item.isHittable
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [interactive], timeout: 20), .completed,
                "Local fixture is not interactive: \(filename)")
            item.tap()
            let open = app.buttons["Open"].firstMatch
            if open.waitForExistence(timeout: 2) { open.tap() }
            expect(app, "selected:\(filename)")
        }
    }
}
