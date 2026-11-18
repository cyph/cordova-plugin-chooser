
import UIKit
import WebKit

// Exercise the actual Capacitor JS/native bridge while controlling picker results.
// The system provider UI is covered separately by the manual Files investigation.
@objc(ChooserFixtureController)
final class ChooserFixtureController: CAPBridgeViewController {
    private var started = false
    private let sample = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-fixture.txt")
    private let report = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-fixture-result")
    private let expected = "Text from the native Capacitor picker."

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        do {
            try expected.write(to: sample, atomically: true, encoding: .utf8)
            waitForWebView(attempts: 150)
        } catch {
            finish("Could not write fixture: \(error)")
        }
    }

    private func waitForWebView(attempts: Int) {
        guard attempts > 0 else { finish("Capacitor web view or native Chooser registration was unavailable"); return }
        webView?.evaluateJavaScript("!!window.fixtureReady && Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Chooser')") { result, _ in
            if result as? Bool == true { self.openPicker(cancel: false) }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForWebView(attempts: attempts - 1) } }
        }
    }

    private func openPicker(cancel: Bool) {
        let script = """
            window.chooserResult = null;
            chooser.getFileData({accept:'text/plain', maxFileSize:1024, format:'text'}).then(
                file => window.chooserResult = file.text,
                error => window.chooserResult = error.code + ':' + error.reason);
            """
        webView?.evaluateJavaScript(script) { _, error in
            if let error = error { self.finish("Could not start picker: \(error)") }
            else { self.returnSelection(cancel: cancel, attempts: 150) }
        }
    }

    private func returnSelection(cancel: Bool, attempts: Int) {
        guard attempts > 0 else { finish("Native document picker did not appear"); return }
        if let picker = presentedViewController as? UIDocumentPickerViewController,
           !picker.isBeingPresented, let delegate = picker.delegate {
            if cancel { delegate.documentPickerWasCancelled?(picker) }
            else { delegate.documentPicker?(picker, didPickDocumentsAt: [sample]) }
            readOutcome(cancel: cancel, attempts: 150)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.returnSelection(cancel: cancel, attempts: attempts - 1)
            }
        }
    }

    private func readOutcome(cancel: Bool, attempts: Int) {
        guard attempts > 0 else { finish("JavaScript selection never settled"); return }
        webView?.evaluateJavaScript("window.chooserResult") { result, error in
            if let error = error {
                self.finish("Could not read picker result: \(error)")
            } else if let value = result as? String {
                let expected = cancel ? "CANCELLED:picker" : self.expected
                if value != expected { self.finish("Unexpected picker result: \(value)") }
                else if cancel { self.finish("passed") }
                else { self.openPicker(cancel: true) }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self.readOutcome(cancel: cancel, attempts: attempts - 1)
                }
            }
        }
    }

    private func finish(_ message: String) {
        try? message.write(to: report, atomically: true, encoding: .utf8)
    }
}
