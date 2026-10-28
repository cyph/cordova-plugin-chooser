import XCTest

final class ChooserUITests: PickerUI {
    func testJSON() { select("JSON", "fixture-json.json") }
    func testCSV() { select("CSV", "fixture-csv.csv") }
    func testPDF() { select("PDF", "fixture-pdf.pdf") }
    func testImage() { select("Image", "fixture-image.png") }
    func testMP4() { select("Video", "fixture-mp4.mp4") }
    func testMOV() { select("Video", "fixture-mov.mov") }
    func testCancelPromiseReopen() { reopen("promise", swipe: false) }
    func testCancelCallbackReopen() { reopen("callback", swipe: false) }
    func testSwipePromiseReopen() { reopen("promise", swipe: true) }
    func testSwipeCallbackReopen() { reopen("callback", swipe: true) }
    func testMetadataOriginalPDF() { select("PDF", "fixture-pdf.pdf") }
    func testMetadataExportedPDF() { select("PDF", "exported-fixture-pdf.pdf") }
    func testUriOriginalPDF() { select("PDF", "fixture-pdf.pdf", environment: ["CHOOSER_METHOD": "uri"], resultPrefix: "copied") }
    func testUriExportedPDF() { select("PDF", "exported-fixture-pdf.pdf", environment: ["CHOOSER_METHOD": "uri"], resultPrefix: "copied") }

    private func reopen(_ mode: String, swipe: Bool) {
        let policy = ProcessInfo.processInfo.environment["CHOOSER_NATIVE_SWIPE_POLICY"]
        if swipe && policy != "allowed" && policy != "prevented" {
            XCTFail("Missing independently verified native swipe policy")
            return
        }
        let app = launch(sheet: swipe, reopen: mode)
        app.buttons["Choose"].tap()
        waitForPicker(app)
        if swipe {
            dismissSheet(app)
            if policy == "prevented" { pendingPicker(app); cancel(app) }
        } else { cancel(app) }
        // JavaScript itself opens request two from the first completion.
        waitForPicker(app)
        // Half-height Files sheets can omit their navigation-bar Cancel button.
        // Exercise the same cancellation route on both requests.
        if swipe {
            dismissSheet(app)
            if policy == "prevented" { pendingPicker(app); cancel(app) }
        } else { cancel(app) }
        expect(app, "canceled:2;counts:1,1")
    }
}
