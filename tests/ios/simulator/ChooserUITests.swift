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
    private func launch(sheet: Bool = false, native: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CHOOSER_TEST_SHEET"] = sheet ? "1" : "0"
        app.launchEnvironment["CHOOSER_NATIVE_CONTROL"] = native ? "1" : "0"
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
    private func browseFixtures(_ app: XCUIApplication) {
        let location = app.cells.containing(NSPredicate(
            format: "label == %@ OR label == %@", "On My iPhone", "On My iPad")).firstMatch
        if !location.exists {
            let browse = app.tabBars.buttons["Browse"].firstMatch
            XCTAssertTrue(browse.waitForExistence(timeout: 15))
            browse.tap()
            // Return through the actual navigation stack, including a folder
            // remembered by an earlier picker. Never inject a filesystem URL.
            for _ in 0..<4 {
                let back = app.buttons["BackButton"].firstMatch
                if !back.waitForExistence(timeout: 2) { break }
                back.tap()
            }
        }
        XCTAssertTrue(location.waitForExistence(timeout: 15))
        location.tap()
        let folder = app.cells.containing(NSPredicate(
            format: "label == %@", "Chooser Fixtures")).firstMatch
        XCTAssertTrue(folder.waitForExistence(timeout: 15))
        folder.tap()
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
        selectFormats(app)
    }
    func testNativeUIKitControl() {
        selectFormats(launch(native: true), csvFirst: true)
    }
    private func selectFormats(_ app: XCUIApplication, csvFirst: Bool = false) {
        var formats = [("JSON", "fixture-json.json"), ("CSV", "fixture-csv.csv"),
                                    ("PDF", "fixture-pdf.pdf"), ("Image", "fixture-image.png"),
                                    ("Video", "fixture-mp4.mp4"), ("Video", "fixture-mov.mov")]
        if csvFirst { formats.swapAt(0, 1) }
        for (button, filename) in formats {
            app.buttons[button].tap()
            browseFixtures(app)
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
