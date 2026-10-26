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

    private func reopen(_ mode: String, swipe: Bool) {
        let app = launch(sheet: swipe, reopen: mode)
        app.buttons["Choose"].tap()
        let frame = presented(app, serial: 1)
        if swipe { dismissSheet(app, frame: frame) } else { cancel(app) }
        // JavaScript itself opens request two from the first completion.
        _ = presented(app, serial: 2)
        cancel(app)
        expect(app, "canceled:2;counts:1,1")
    }
}
