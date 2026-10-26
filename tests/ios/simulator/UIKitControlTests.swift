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
        nativeSwipe(app, identity: "UIKitControlTests/testSwipe()", hasAdaptiveDelegate: true)
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
        nativeSwipe(app, identity: "UIKitControlTests/testSystemDelegateSwipe()", hasAdaptiveDelegate: false)
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
    func testSeedJSON() { export("fixture-json.json", seed: true) }
    func testSeedCSV() { export("fixture-csv.csv", seed: true) }
    func testSeedPDF() { export("fixture-pdf.pdf", seed: true) }
    func testSeedImage() { export("fixture-image.png", seed: true) }
    func testSeedMP4() { export("fixture-mp4.mp4", seed: true) }
    func testSeedMOV() { export("fixture-mov.mov", seed: true) }
    private func export(_ filename: String, seed: Bool = false) {
        let app = launch(environment: ["CHOOSER_EXPORT_FILE": filename, "CHOOSER_EXPORT_SEED": seed ? "1" : "0"])
        app.buttons["ExportFixture"].tap()
        presented(app, serial: 1)
        browseFixtures(app)
        let buttons = app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", argumentArray: [["Export", "Save", "Copy", "Move"]]))
        tapVisible(buttons)
        expect(app, "selected:\(seed ? "" : "exported-")\(filename)")
    }
}
