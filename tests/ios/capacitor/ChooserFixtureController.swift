
import UIKit
import WebKit
import Network

// Exercise the actual Capacitor JS/native bridge while controlling picker results.
// The system provider UI is covered separately by the manual Files investigation.
@objc(ChooserFixtureController)
final class ChooserFixtureController: CAPBridgeViewController {
    private var started = false
    private let sample = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-fixture.txt")
    private let report = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-fixture-result")
    private let expected = "Text from the native Capacitor picker."
    private enum Phase { case noContent, replaceDocument, afterReplacement }
    private var phase = Phase.noContent
    private var listener: NWListener?

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
            if result as? Bool == true { self.openPicker() }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForWebView(attempts: attempts - 1) } }
        }
    }

    private func openPicker() {
        let script = """
            window.chooserResult = null;
            chooser.getFileData({accept:'text/plain', maxFileSize:1024, format:'text'}).then(
                file => window.chooserResult = file.text,
                error => window.chooserResult = error.code + ':' + error.reason);
            true;
            """
        webView?.evaluateJavaScript(script) { _, error in
            if let error = error { self.finish("Could not start picker: \(error)") }
            else { self.returnSelection(attempts: 150) }
        }
    }

    private func returnSelection(attempts: Int) {
        guard attempts > 0 else { finish("Native document picker did not appear"); return }
        if let picker = presentedViewController as? UIDocumentPickerViewController,
           !picker.isBeingPresented, let delegate = picker.delegate {
            switch phase {
            case .noContent:
                checkProvisionalNavigation { [weak self] in
                    guard let self else { return }
                    delegate.documentPicker?(picker, didPickDocumentsAt: [self.sample])
                    self.readOutcome(cancel: false, attempts: 150)
                }
            case .replaceDocument:
                phase = .afterReplacement
                webView?.reload()
                waitForReplacement(attempts: 150)
            case .afterReplacement:
                delegate.documentPickerWasCancelled?(picker)
                readOutcome(cancel: true, attempts: 150)
            }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.returnSelection(attempts: attempts - 1)
            }
        }
    }

    private func checkProvisionalNavigation(complete: @escaping () -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            let endpoint = try NWListener(using: parameters)
            listener = endpoint
            endpoint.stateUpdateHandler = { [weak self] state in
                if case .ready = state, let port = endpoint.port,
                   let url = URL(string: "http://127.0.0.1:\(port.rawValue)/no-content") {
                    DispatchQueue.main.async { self?.webView?.load(URLRequest(url: url)) }
                }
            }
            endpoint.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .main)
                connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
                    let response = Data("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".utf8)
                    connection.send(content: response, completion: .contentProcessed { error in
                        connection.cancel()
                        DispatchQueue.main.async {
                            guard let self else { return }
                            if let error { self.finish("Could not send HTTP 204: \(error)") }
                            else { self.waitForNoContent(complete: complete, attempts: 150) }
                        }
                    })
                }
            }
            endpoint.start(queue: .main)
        } catch { finish("Could not start loopback HTTP fixture: \(error)") }
    }

    private func waitForNoContent(complete: @escaping () -> Void, attempts: Int) {
        guard attempts > 0 else { finish("HTTP 204 navigation did not finish"); return }
        if webView?.isLoading == false {
            listener?.cancel()
            listener = nil
            complete()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.waitForNoContent(complete: complete, attempts: attempts - 1)
            }
        }
    }

    private func waitForReplacement(attempts: Int) {
        guard attempts > 0 else { finish("Document replacement did not reset the native picker"); return }
        if presentedViewController == nil, webView?.isLoading == false {
            waitForWebView(attempts: 150)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForReplacement(attempts: attempts - 1) }
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
                else {
                    self.phase = .replaceDocument
                    self.openPicker()
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self.readOutcome(cancel: cancel, attempts: attempts - 1)
                }
            }
        }
    }

    private func finish(_ message: String) {
        listener?.cancel()
        listener = nil
        try? message.write(to: report, atomically: true, encoding: .utf8)
    }
}
