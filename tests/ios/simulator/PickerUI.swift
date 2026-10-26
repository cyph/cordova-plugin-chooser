import XCTest

class PickerUI: XCTestCase {
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
        let app = XCUIApplication()
        if app.state != .notRunning {
            if let run = testRun, run.failureCount > 0 {
                let hierarchy = XCTAttachment(string: app.debugDescription)
                hierarchy.name = "Fixture UI hierarchy"
                hierarchy.lifetime = .keepAlways
                add(hierarchy)
            }
            // Termination also closes a remote picker. Avoid synthesizing more
            // input into an accessibility tree that has already failed.
            app.terminate()
        }
        let files = XCUIApplication(bundleIdentifier: "com.apple.DocumentsApp")
        if files.state != .notRunning { files.terminate() }
        super.tearDown()
    }
    func launch(sheet: Bool = false, reopen: String = "", environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CHOOSER_TEST_SHEET"] = sheet ? "1" : "0"
        app.launchEnvironment["CHOOSER_REOPEN"] = reopen
        app.launchEnvironment["CHOOSER_CASE"] = name
        for (key, value) in environment { app.launchEnvironment[key] = value }
        app.launch()
        XCTAssertTrue(app.staticTexts["Outcome"].waitForExistence(timeout: 20))
        expect(app, "ready")
        return app
    }
    func expect(_ app: XCUIApplication, _ text: String) {
        expectation(for: NSPredicate(format: "label == %@", text), evaluatedWith: app.staticTexts["Outcome"])
        waitForExpectations(timeout: 30)
    }
    func cancel(_ app: XCUIApplication) {
        tapVisible(app.navigationBars.buttons.matching(identifier: "Cancel"))
    }
    func presented(_ app: XCUIApplication, serial: Int) {
        let marker = app.staticTexts["PickerReady"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard marker.exists, let value = marker.value as? String,
                  let data = value.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["serial"] as? Int == serial, object["beingPresented"] as? Bool == false else { return false }
            return true
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed, "Picker presentation did not complete: \(serial)")
    }
    func dismissSheet(_ app: XCUIApplication) {
        // Presentation completion precedes the remote Files UI. Wait for an
        // interactive navigation control before taking gesture geometry;
        // otherwise the query can capture the host's placeholder sheet.
        let remoteReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.navigationBars.buttons.allElementsBoundByIndex.contains {
                $0.exists && $0.isEnabled && $0.isHittable
            }
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [remoteReady], timeout: 60), .completed, "Remote picker navigation did not become interactive")
        // The outer document-picker host can cover the screen while its remote
        // Files view presents a sheet. Prefer the native handle; Files titles
        // can be buttons that open folder menus instead of dragging the sheet.
        let grabber = app.buttons["Sheet Grabber"].firstMatch
        let navigation = firstHittable(app.navigationBars)
        let hasGrabber = grabber.exists && grabber.isHittable
        guard let target = hasGrabber ? grabber : navigation else {
            XCTFail("Missing visible sheet grabber or navigation bar")
            return
        }
        let marker = app.staticTexts["PickerReady"]
        if marker.exists {
            let probe = XCTAttachment(string: marker.value as? String ?? "Missing presentation value")
            probe.name = "Presentation before swipe"
            probe.lifetime = .keepAlways
            add(probe)
        }
        // Remote accessibility geometry can change between snapshot requests.
        // Capture each rectangle once, then synthesize input without re-querying it.
        let screen = app.frame
        let bounds = target.frame
        XCTAssertGreaterThan(bounds.midY, screen.minY, "Expected an adaptive sheet")
        let origin = app.coordinate(withNormalizedOffset: .zero)
        // With no handle, use the sheet's clear margin above its toolbar.
        // Keep the touch outside the title, navigation buttons and search field.
        let point = CGPoint(x: bounds.midX, y: hasGrabber ? bounds.midY : bounds.minY - 8)
        XCTAssertFalse(bounds.isEmpty, "Empty gesture target")
        XCTAssertTrue(screen.contains(point), "Gesture target outside the screen")
        let end = origin.withOffset(CGVector(dx: point.x - screen.minX, dy: screen.height - 8))
        let start = origin.withOffset(CGVector(dx: point.x - screen.minX, dy: point.y - screen.minY))
        attachScreen("Immediately before swipe")
        print("CHOOSER_UI dismiss screen=\(screen) target=\(bounds) point=\(point)")
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
        attachScreen("Immediately after swipe")
    }
    private func attachScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    func firstHittable(_ query: XCUIElementQuery) -> XCUIElement? {
        query.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
    }
    func tapVisible(_ query: XCUIElementQuery) {
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
    func browseFixtures(_ app: XCUIApplication) {
        let location = app.cells.matching(NSPredicate(
            format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "On My iPhone", "On My iPad"))
        // Files uses a top segmented control on iPad and a tab bar on iPhone.
        let browse = app.buttons.matching(identifier: "Browse")
        let folder = app.cells.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Chooser Fixtures"))
        // Export pickers can reopen directly inside the last destination.
        // Observe the toolbar title without activating its folder menu.
        let currentFolder = app.navigationBars.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Chooser Fixtures"))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.firstHittable(currentFolder) != nil || self.firstHittable(folder) != nil || self.firstHittable(location) != nil || self.firstHittable(browse) != nil
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed)
        if firstHittable(currentFolder) != nil { return }
        if firstHittable(folder) == nil && firstHittable(location) == nil {
            tapVisible(browse)
            // Return through the actual navigation stack, including a folder
            // remembered by an earlier picker. Never inject a filesystem URL.
            for _ in 0..<4 {
                if firstHittable(currentFolder) != nil { return }
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
    func select(_ button: String, _ filename: String, environment: [String: String] = [:], resultPrefix: String = "selected") {
        let app = launch(environment: environment)
        app.buttons[button].tap()
        presented(app, serial: 1)
        browseFixtures(app)
        let stem = (filename as NSString).deletingPathExtension
        let item = app.cells.matching(NSPredicate(
            format: "label BEGINSWITH %@ OR label BEGINSWITH %@", filename, stem)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 20), "Missing local fixture \(filename)")
        XCTAssertTrue(item.isEnabled)
        let interactive = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in item.exists && item.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [interactive], timeout: 20), .completed, "Local fixture is not interactive: \(filename)")
        // A Files cell's center can fall on the filename outside the thumbnail's
        // activation region. Target the visible icon rather than the cell box.
        let thumbnail = item.images.firstMatch
        XCTAssertTrue(thumbnail.waitForExistence(timeout: 20), "Missing fixture thumbnail: \(filename)")
        let bounds = thumbnail.frame
        let point = CGPoint(x: bounds.midX, y: bounds.midY)
        XCTAssertFalse(bounds.isEmpty, "Empty fixture thumbnail: \(filename)")
        XCTAssertTrue(item.frame.contains(point), "Thumbnail outside its visible cell: \(filename)")
        XCTAssertTrue(app.frame.contains(point), "Thumbnail outside the screen: \(filename)")
        // Images inside the hittable file cell need not be accessibility hit
        // targets themselves. Send a physical tap inside the visible thumbnail.
        print("CHOOSER_UI select \(filename) cell=\(item.frame) thumbnail=\(bounds) point=\(point)")
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: point.x - app.frame.minX, dy: point.y - app.frame.minY)).tap()
        let open = app.buttons["Open"].firstMatch
        if open.waitForExistence(timeout: 2) { open.tap() }
        expect(app, "\(resultPrefix):\(filename)")
    }

    func pendingPicker(_ app: XCUIApplication) {
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", "ready"), object: app.staticTexts["Outcome"])
        settled.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 2), .completed, "A prevented swipe settled the request")
        XCTAssertFalse(app.buttons["Choose"].isHittable, "The picker disappeared without completing the request")
        XCTAssertNotNil(firstHittable(app.navigationBars.buttons.matching(identifier: "Cancel")), "Pending picker has no usable Cancel control")
    }

    func nativeSwipe(_ app: XCUIApplication, identity: String, hasAdaptiveDelegate: Bool) {
        dismissSheet(app)
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.navigationBars.count == 0 && app.buttons["Choose"].isHittable
        }, object: nil)
        let dismissed = XCTWaiter.wait(for: [gone], timeout: 5) == .completed
        if dismissed {
            if hasAdaptiveDelegate { expect(app, "canceled:1") }
        } else {
            pendingPicker(app)
            cancel(app)
            expect(app, "canceled:1")
        }
        let value = ["case": identity, "outcome": dismissed ? "dismissed" : "prevented"]
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print("CHOOSER_NATIVE_SWIPE \(String(data: data, encoding: .utf8)!)")
    }
}
