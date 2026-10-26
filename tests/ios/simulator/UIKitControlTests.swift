import XCTest

final class UIKitControlTests: PickerUI {
    func testJSON() { select("JSON", "fixture-json.json") }
    func testCSV() { select("CSV", "fixture-csv.csv") }
    func testPDF() { select("PDF", "fixture-pdf.pdf") }
    func testImage() { select("Image", "fixture-image.png") }
    func testMP4() { select("Video", "fixture-mp4.mp4") }
    func testMOV() { select("Video", "fixture-mov.mov") }
    func testCancel() {
        let app = launch()
        app.buttons["Choose"].tap()
        presented(app, serial: 1)
        cancel(app)
        expect(app, "canceled:1")
    }
    func testSwipe() {
        let app = launch(sheet: true)
        app.buttons["Choose"].tap()
        presented(app, serial: 1)
        dismissSheet(app)
        expect(app, "canceled:1")
    }
    func testPlainSheetSwipe() {
        let app = launch(sheet: true)
        app.buttons["PlainSheet"].tap()
        presented(app, serial: 1)
        dismissSheet(app)
        expect(app, "canceled:1")
    }
    func testSystemDelegateSwipe() {
        let app = launch()
        app.buttons["SystemDelegate"].tap()
        dismissSheet(app)
        // Observe the real transition without installing an adaptive delegate
        // or treating a synthesized cancellation callback as dismissal.
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.navigationBars.count == 0 && app.buttons["Choose"].isHittable
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 30), .completed, "System-managed picker did not dismiss")
    }
    func testImportOriginalJSON() { select("JSON", "fixture-json.json") }
    func testOpenOriginalJSON() { select("JSON", "fixture-json.json", environment: ["CHOOSER_PROVIDER_MODE": "open"]) }
    func testImportExportedJSON() { select("JSON", "exported-fixture-json.json") }
    func testOpenExportedJSON() { select("JSON", "exported-fixture-json.json", environment: ["CHOOSER_PROVIDER_MODE": "open"]) }
    func testImportOriginalPDF() { select("PDF", "fixture-pdf.pdf") }
    func testOpenOriginalPDF() { select("PDF", "fixture-pdf.pdf", environment: ["CHOOSER_PROVIDER_MODE": "open"]) }
    func testImportExportedPDF() { select("PDF", "exported-fixture-pdf.pdf") }
    func testOpenExportedPDF() { select("PDF", "exported-fixture-pdf.pdf", environment: ["CHOOSER_PROVIDER_MODE": "open"]) }
    func testExportJSON() { export("fixture-json.json") }
    func testExportPDF() { export("fixture-pdf.pdf") }
    private func export(_ filename: String) {
        let app = launch(environment: ["CHOOSER_EXPORT_FILE": filename])
        app.buttons["ExportFixture"].tap()
        presented(app, serial: 1)
        browseFixtures(app)
        let buttons = app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", argumentArray: [["Export", "Save", "Copy", "Move"]]))
        tapVisible(buttons)
        expect(app, "selected:exported-\(filename)")
    }
    func testRequestedPageSheetSwipe() {
        let app = launch(environment: ["CHOOSER_PRESENTATION": "pageSheet"])
        app.buttons["Choose"].tap()
        presented(app, serial: 1)
        dismissSheet(app)
        expect(app, "canceled:1")
    }
    func testRequestedFullScreenCancel() {
        let app = launch(environment: ["CHOOSER_PRESENTATION": "fullScreen"])
        app.buttons["Choose"].tap()
        presented(app, serial: 1)
        cancel(app)
        expect(app, "canceled:1")
    }
    func testDefaultSwipeThenCancel() {
        let app = launch()
        app.buttons["SystemDelegate"].tap()
        observeSwipeThenCancel(app)
    }
}
