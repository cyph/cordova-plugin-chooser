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
    func expect(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 30) {
        var observed = "unavailable"
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            // Resolving a descendant while Files dismisses can block inside
            // XCTest even after the host has received its real callback. Read
            // one application snapshot and inspect its immutable nodes instead.
            guard let root = try? app.snapshot() else { return false }
            var pending = [root]
            var labels: [String] = []
            while let element = pending.popLast() {
                pending.append(contentsOf: element.children)
                if element.elementType == .staticText && element.identifier == "Outcome" {
                    labels.append(element.label)
                }
            }
            let value = labels.count == 1 ? labels[0] : "unavailable (\(labels.count) outcome labels)"
            if value != observed {
                print("CHOOSER_UI outcome snapshot=\(value)")
                observed = value
            }
            return labels.count == 1 && labels[0] == text
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: timeout), .completed,
                       "Expected fixture outcome \(text); last observed \(observed)")
    }
    func cancel(_ app: XCUIApplication) {
        let buttons = app.navigationBars.buttons
        let cancel = buttons.matching(identifier: "Cancel")
        let names = ["BackButton", "DOC.navBarButton.backInHistory", "Back", "Go Back"]
        let screen = app.frame
        let deadline = ProcessInfo.processInfo.systemUptime + 60
        // Files can restore a folder whose toolbar exposes Back and More but
        // no Cancel button. Navigate through visible native controls rather
        // than tapping a hidden accessibility placeholder behind that toolbar.
        for _ in 0..<4 {
            var action: (cancel: Bool, frame: CGRect, identifier: String, label: String)?
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                // Reading attributes separately can re-resolve a Back button
                // after navigation has already replaced it with Cancel. Capture
                // the toolbar once, then inspect only its immutable snapshots.
                guard let toolbar = try? app.navigationBars.firstMatch.snapshot() else { return false }
                var pending = toolbar.children
                var candidates: [XCUIElementSnapshot] = []
                while let element = pending.popLast() {
                    pending.append(contentsOf: element.children)
                    let frame = element.frame
                    if element.elementType == .button && element.isEnabled &&
                        frame.width >= 20 && frame.height >= 20 && screen.contains(frame) {
                        candidates.append(element)
                    }
                }
                let close = candidates.first { $0.identifier == "Cancel" || $0.label == "Cancel" }
                guard let target = close ?? candidates.first(where: { names.contains($0.identifier) || names.contains($0.label) }) else { return false }
                action = (close != nil, target.frame, target.identifier, target.label)
                return true
            }, object: nil)
            let remaining = max(0, deadline - ProcessInfo.processInfo.systemUptime)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: remaining), .completed, "Missing native cancellation or back navigation")
            guard let target = action else {
                XCTFail("Missing native cancellation navigation snapshot")
                return
            }
            if target.cancel { break }
            attachScreen("Navigate back to native Cancel")
            print("CHOOSER_UI cancellation back=\(target.identifier) label=\(target.label) frame=\(target.frame)")
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                dx: target.frame.midX - screen.minX, dy: target.frame.midY - screen.minY)).tap()
        }
        tapPickerButton(app, cancel)
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
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed, "Picker presentation did not complete: \(serial)")
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
        // Keep the release above the rounded sheet edge and system gesture
        // area. Ending on that boundary can cancel an interactive dismissal.
        let endPoint = CGPoint(x: point.x, y: screen.maxY - 44)
        XCTAssertGreaterThan(endPoint.y, point.y, "Gesture has no downward travel")
        XCTAssertTrue(screen.contains(endPoint), "Gesture endpoint outside the screen")
        let end = origin.withOffset(CGVector(dx: endPoint.x - screen.minX, dy: endPoint.y - screen.minY))
        let start = origin.withOffset(CGVector(dx: point.x - screen.minX, dy: point.y - screen.minY))
        attachScreen("Immediately before swipe")
        print("CHOOSER_UI dismiss screen=\(screen) target=\(bounds) point=\(point) end=\(endPoint)")
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
    private func pickerButtonFrame(_ button: XCUIElement, in app: XCUIApplication) -> CGRect? {
        guard button.exists, button.isEnabled else { return nil }
        let bounds = button.frame
        // Discard placeholder geometry before the native toolbar finishes layout.
        guard bounds.width >= 20, bounds.height >= 20, app.frame.contains(bounds) else { return nil }
        return bounds
    }
    func tapPickerButton(_ app: XCUIApplication, _ query: XCUIElementQuery) {
        let button = query.firstMatch
        let deadline = ProcessInfo.processInfo.systemUptime + 60
        XCTAssertTrue(button.waitForExistence(timeout: 60), "Missing native picker action")
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.pickerButtonFrame(button, in: app) != nil
        }, object: nil)
        let remaining = max(0, deadline - ProcessInfo.processInfo.systemUptime)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: remaining), .completed, "Native picker action did not finish layout")
        let screen = app.frame
        guard let bounds = pickerButtonFrame(button, in: app) else {
            XCTFail("Native picker action lost its visible geometry")
            return
        }
        let point = CGPoint(x: bounds.midX, y: bounds.midY)
        let label = button.label
        XCTAssertTrue(screen.contains(point), "Native picker action is outside the screen")
        attachScreen("Before native action: \(label)")
        print("CHOOSER_UI native action=\(label) screen=\(screen) target=\(bounds) point=\(point)")
        // Send physical input to the captured visible button center. The
        // caller verifies the real delegate or bridge outcome.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: point.x - screen.minX, dy: point.y - screen.minY)).tap()
        attachScreen("After native action: \(label)")
    }
    private struct NavigationTarget {
        let kind: String
        let label: String
        let identifier: String
        let frame: CGRect
    }
    private struct FilesNavigation {
        let screen: CGRect
        let arrived: Bool
        let target: NavigationTarget?
        let signature: String
    }
    private var lastNavigationSnapshot = "No Files navigation snapshot captured."
    private func filesNavigation(_ app: XCUIApplication, screen: CGRect) -> FilesNavigation? {
        // Files lives in a remote accessibility context that an application
        // snapshot can omit. Recents has no Browse container, so include its
        // native mode tabs when resolving the navigation snapshot.
        let root: XCUIElementSnapshot
        do {
            root = try app.descendants(matching: .any).matching(NSPredicate(
                format: "identifier IN %@", argumentArray: [["Browse View (Picker)", "DOC.browsingModeTabBar"]]
            )).firstMatch.snapshot()
        }
        catch {
            lastNavigationSnapshot = "Files snapshot failed: \(error)"
            return nil
        }
        var folder: NavigationTarget?
        var location: NavigationTarget?
        var back: NavigationTarget?
        var browse: NavigationTarget?
        var arrived = false
        var loadingDestination = false
        var titles: [String] = []
        var details: [String] = []
        var count = 0
        var maximumDepth = 0
        let backNames = ["BackButton", "DOC.navBarButton.backInHistory", "Back", "Go Back"]
        func folderFrame(_ cell: XCUIElementSnapshot) -> CGRect {
            var pending = cell.children
            var icon: CGRect?
            while let child = pending.popLast() {
                pending.append(contentsOf: child.children)
                let bounds = child.frame
                if child.elementType == .image && bounds.width >= 20 && bounds.height >= 20 &&
                    cell.frame.contains(bounds) && screen.contains(bounds) &&
                    bounds.width * bounds.height > (icon.map { $0.width * $0.height } ?? 0) {
                    icon = bounds
                }
            }
            return icon ?? cell.frame
        }
        func visit(_ node: XCUIElementSnapshot, inNavigation: Bool = false, inTabs: Bool = false, depth: Int = 0) {
            count += 1
            maximumDepth = max(maximumDepth, depth)
            let navigation = node.elementType == .navigationBar || (inNavigation && node.elementType != .cell)
            let tabs = node.elementType == .tabBar || (inTabs && node.elementType != .cell)
            let bounds = node.frame
            if node.elementType == .window || node.elementType == .navigationBar || node.elementType == .tabBar || node.elementType == .cell || navigation || tabs {
                details.append("\(node.elementType) enabled=\(node.isEnabled) frame=\(bounds) identifier=\(node.identifier) label=\(node.label)")
            }
            // Observing a title does not require an enabled menu or a touch
            // target's minimum size. Only controls receiving input do.
            if !bounds.isEmpty && screen.contains(bounds) {
                if (navigation || tabs) && (node.elementType == .button || node.elementType == .staticText) {
                    titles.append(node.label)
                    if navigation {
                        if node.label.hasPrefix("Chooser Fixtures") { arrived = true }
                        let isBack = backNames.contains(node.identifier) || backNames.contains(node.label)
                        if !isBack && (node.label.hasPrefix("On My iPhone") || node.label.hasPrefix("On My iPad") || node.label == "Browse") {
                            loadingDestination = true
                        }
                    }
                }
                if node.isEnabled && bounds.width >= 20 && bounds.height >= 20 && node.elementType == .cell {
                    if node.label.hasPrefix("Chooser Fixtures") {
                        folder = NavigationTarget(kind: "folder", label: node.label, identifier: node.identifier, frame: folderFrame(node))
                    } else if node.label.hasPrefix("On My iPhone") || node.label.hasPrefix("On My iPad") {
                        location = NavigationTarget(kind: "location", label: node.label, identifier: node.identifier, frame: bounds)
                    }
                } else if node.isEnabled && bounds.width >= 20 && bounds.height >= 20 && node.elementType == .button {
                    if navigation && (backNames.contains(node.identifier) || backNames.contains(node.label)) {
                        back = NavigationTarget(kind: "back", label: node.label, identifier: node.identifier, frame: bounds)
                    }
                    if node.identifier == "Browse" || node.label == "Browse" {
                        browse = NavigationTarget(kind: "browse", label: node.label, identifier: node.identifier, frame: bounds)
                    }
                }
            }
            for child in node.children { visit(child, inNavigation: navigation, inTabs: tabs, depth: depth + 1) }
        }
        visit(root)
        lastNavigationSnapshot = "screen=\(screen) root=\(root.elementType):\(root.identifier) \(root.frame) nodes=\(count) depth=\(maximumDepth) titles=\(titles) arrived=\(arrived)\n" + details.joined(separator: "\n")
        guard !titles.isEmpty else { return nil }
        // Only a title inside the actual navigation bar confirms arrival. A
        // folder cell with the same name is still a destination to open.
        let signature = titles.sorted().joined(separator: "|") + ";folder=\(folder != nil);location=\(location != nil)"
        // At a known parent, wait for its contents instead of immediately
        // navigating away while the provider is still populating the view.
        let target = folder ?? location ?? (loadingDestination ? nil : back ?? browse)
        return FilesNavigation(screen: screen, arrived: arrived, target: target, signature: signature)
    }
    func browseFixtures(_ app: XCUIApplication) {
        // Screen coordinates are separate from the remote browser's frame.
        // Capture the application's visible frame once, outside the poll.
        let screen = app.frame
        XCTAssertFalse(screen.isEmpty, "Application has no visible frame")
        var previous: String?
        var backCount = 0
        for step in 0...7 {
            var observed: FilesNavigation?
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let state = self.filesNavigation(app, screen: screen) else { return false }
                guard state.arrived || (state.target != nil && state.signature != previous) else { return false }
                observed = state
                return true
            }, object: nil)
            let result = XCTWaiter.wait(for: [ready], timeout: step == 0 ? 60 : 20)
            if result != .completed {
                let attachment = XCTAttachment(string: lastNavigationSnapshot)
                attachment.name = "Files navigation snapshot state"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            XCTAssertEqual(result, .completed, "Files navigation did not reach its next destination")
            guard let state = observed else {
                XCTFail("Missing Files navigation snapshot")
                return
            }
            if state.arrived {
                print("CHOOSER_UI navigation arrived \(lastNavigationSnapshot.split(separator: "\n").first ?? "")")
                return
            }
            guard step < 7 else {
                XCTFail("Fixture folder did not open within the navigation limit")
                return
            }
            guard let target = state.target else {
                XCTFail("Missing visible native Files navigation control")
                return
            }
            if target.kind == "back" {
                backCount += 1
                XCTAssertLessThanOrEqual(backCount, 4, "Files navigation exceeded the back stack limit")
            }
            previous = state.signature
            attachScreen("Before Files navigation: \(target.kind)")
            print("CHOOSER_UI navigate kind=\(target.kind) label=\(target.label) identifier=\(target.identifier) frame=\(target.frame)")
            // Touch the visible control captured above. Wait for a different
            // navigation state before sending another input to the remote UI.
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                dx: target.frame.midX - state.screen.minX, dy: target.frame.midY - state.screen.minY)).tap()
            attachScreen("After Files navigation: \(target.kind)")
        }
        XCTFail("Fixture folder did not open within the navigation limit")
    }
    func select(_ button: String, _ filename: String, environment: [String: String] = [:], resultPrefix: String = "selected") {
        let app = launch(environment: environment)
        app.buttons[button].tap()
        if environment["CHOOSER_SYSTEM_PROVIDER"] != "1" { presented(app, serial: 1) }
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
        XCTAssertNotNil(pickerButtonFrame(app.navigationBars.buttons.matching(identifier: "Cancel").firstMatch, in: app), "Pending picker has no visible enabled Cancel control")
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
