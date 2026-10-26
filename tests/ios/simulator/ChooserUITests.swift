import XCTest

final class ChooserUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }
    override func tearDown() {
        continueAfterFailure = true
        if let run = testRun, run.failureCount > 0 {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.lifetime = .keepAlways
            add(screenshot)
        }
        // Cancel before terminating so an unfinished provider interaction cannot
        // leave the shared Files service attached to the next test's picker.
        let app = XCUIApplication()
        if app.state != .notRunning {
            app.activate()
            let button = app.buttons["Cancel"].firstMatch
            if button.exists && button.isHittable {
                button.tap()
                let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    !button.exists
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 15), .completed,
                    "The fixture picker did not close during cleanup")
            }
            app.terminate()
        }
        let files = XCUIApplication(bundleIdentifier: "com.apple.DocumentsApp")
        if files.state != .notRunning { files.terminate() }
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
    private func firstHittable(_ query: XCUIElementQuery) -> XCUIElement? {
        query.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
    }
    private func tapVisible(_ query: XCUIElementQuery) {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.firstHittable(query) != nil
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed)
        if let element = firstHittable(query) {
            XCTAssertTrue(element.isEnabled)
            element.tap()
        } else {
            XCTFail("No hittable navigation target")
        }
    }
    private func browseFixtures(_ app: XCUIApplication) {
        let location = app.cells.matching(NSPredicate(
            format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "On My iPhone", "On My iPad"))
        // Files uses a top segmented control on iPad and a tab bar on iPhone.
        let browse = app.buttons.matching(identifier: "Browse")
        let folder = app.cells.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Chooser Fixtures"))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.firstHittable(folder) != nil || self.firstHittable(location) != nil || self.firstHittable(browse) != nil
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed)
        if firstHittable(folder) == nil && firstHittable(location) == nil {
            tapVisible(browse)
            // Return through the actual navigation stack, including a folder
            // remembered by an earlier picker. Never inject a filesystem URL.
            for _ in 0..<4 {
                if firstHittable(folder) != nil || firstHittable(location) != nil { break }
                let names = ["BackButton", "Back", "Go Back"]
                let buttons = app.buttons.matching(NSPredicate(format: "identifier IN %@ OR label IN %@", argumentArray: [names, names]))
                guard let back = firstHittable(buttons), back.isEnabled else { break }
                back.tap()
            }
        }
        let destination = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.firstHittable(folder) != nil || self.firstHittable(location) != nil
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [destination], timeout: 20), .completed)
        if firstHittable(folder) == nil {
            tapVisible(location)
        }
        tapVisible(folder)
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
        // Drag the grabber area at the sheet's center, clear of the iPad sidebar.
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let top = origin.withOffset(CGVector(dx: app.frame.width / 2,
            dy: cancelButton.frame.minY - app.frame.minY - 5))
        top.press(forDuration: 0.1, thenDragTo: origin.withOffset(
            CGVector(dx: app.frame.width / 2, dy: app.frame.height - 12)),
            withVelocity: .fast, thenHoldForDuration: 0)
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
        let files = XCUIApplication(bundleIdentifier: "com.apple.DocumentsApp")
        files.launch()
        if files.buttons["Continue"].exists { files.buttons["Continue"].tap() }
        browseFixtures(files)
        files.terminate()
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
            let item = app.cells.matching(NSPredicate(
                format: "label BEGINSWITH %@ OR label BEGINSWITH %@", filename, stem)).firstMatch
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
