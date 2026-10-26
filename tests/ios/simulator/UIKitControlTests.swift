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
}
