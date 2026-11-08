import XCTest
import UIKit
import WebKit
#if canImport(Cordova)
import Cordova
#endif
@testable import ChooserBridgeHost

private struct BridgeFailure: Error, CustomStringConvertible {
    let description: String
}

// Never put WKScriptMessageHandler conformance on the CDVViewController:
// Cordova treats that conformance as a replacement for its native exec hook.
@MainActor
private final class BridgeMessages: NSObject, WKScriptMessageHandler {
    static let name = "chooserBridge"
    let nonce: String
    let trace: URL
    weak var webView: WKWebView?
    var running = false
    var invocationReturned = false
    private(set) var readyCount = 0
    private(set) var completionCount = 0
    private(set) var nonceErrors = 0
    private(set) var errors: [String] = []
    private(set) var completion: [String: Any]?

    init(nonce: String, cache: URL) {
        self.nonce = nonce
        trace = cache.appendingPathComponent("chooser-fixture-events.log")
        super.init()
    }

    var diagnostic: String {
        "nonce=\(nonce) ready=\(readyCount) completion=\(completionCount) nonceErrors=\(nonceErrors) errors=\(errors)"
    }

    func record(_ message: String) {
        NSLog("CHOOSER_BRIDGE %@ %@", message, diagnostic)
        let fields: [String: Any] = [
            "case": "ChooserBridgeTests/testCordovaBridgeRoundTrip()",
            "time": Date().timeIntervalSince1970, "message": "bridge \(message)",
            "nonce": nonce, "readyCount": readyCount, "completionCount": completionCount,
            "nonceErrors": nonceErrors, "errors": errors
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) + Data([10])
            if !FileManager.default.fileExists(atPath: trace.path) {
                guard FileManager.default.createFile(atPath: trace.path, contents: nil) else {
                    throw BridgeFailure(description: "Cannot create bridge trace")
                }
            }
            let handle = try FileHandle(forWritingTo: trace)
            defer { try? handle.close() }
            _ = try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            errors.append("Trace write failed: \(error)")
        }
    }

    func fail(_ message: String) {
        errors.append(message)
        record("error: \(message)")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.name, message.frameInfo.isMainFrame, message.webView === webView,
              let body = message.body as? [String: Any] else {
            fail("Malformed bridge message or unexpected frame/web view")
            return
        }
        guard body["nonce"] as? String == nonce else {
            nonceErrors += 1
            fail("Bridge message nonce mismatch: \(body)")
            return
        }
        switch body["kind"] as? String {
        case "ready":
            readyCount += 1
            guard readyCount == 1, !running, completionCount == 0,
                  body["readyCount"] as? Int == 1, body["completionCount"] as? Int == 0 else {
                fail("Duplicate or out-of-order readiness: \(body)")
                return
            }
            record("ready")
        case "complete":
            completionCount += 1
            guard running, readyCount == 1, completionCount == 1,
                  body["readyCount"] as? Int == 1, body["completionCount"] as? Int == 1 else {
                fail("Duplicate or out-of-order completion: \(body)")
                return
            }
            completion = body
            record("complete: \(body)")
        case "error":
            fail("JavaScript: \(body)")
        default:
            fail("Unknown bridge message: \(body)")
        }
    }

    func wait(until deadline: TimeInterval, phase: String, for predicate: @MainActor () -> Bool) async throws {
        while true {
            guard errors.isEmpty else { throw BridgeFailure(description: diagnostic) }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                fail("\(phase) timed out")
                throw BridgeFailure(description: diagnostic)
            }
            if predicate() { return }
            // Yield the main actor to WebKit/Cordova; never redispatch an operation.
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }
}

@MainActor
private final class BridgeViewController: CDVViewController {
    var messages: BridgeMessages?
    var nonceScript = ""

    // Keep Cordova's loadView/viewDidLoad and plugin registration intact. This
    // hook installs observation before super.viewDidLoad loads the start page.
    override func newCordovaView(withFrame bounds: CGRect) -> UIView {
        let view = super.newCordovaView(withFrame: bounds)
        guard let webView = view as? WKWebView, let messages = messages else {
            messages?.fail("Cordova did not construct a WKWebView")
            return view
        }
        messages.webView = webView
        let content = webView.configuration.userContentController
        content.add(messages, name: BridgeMessages.name)
        content.addUserScript(WKUserScript(source: nonceScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return view
    }
}

final class ChooserBridgeTests: XCTestCase {
    @MainActor
    func testCordovaBridgeRoundTrip() async throws {
        guard Bundle.main.bundleIdentifier == "com.cyph.chooser.bridge",
              Bundle.main.object(forInfoDictionaryKey: "ChooserNativeTests") as? Bool == true else {
            throw BridgeFailure(description: "Run in the dedicated ChooserBridgeHost with ChooserNativeTests=true")
        }
        let cache = try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
        let nonce = UUID().uuidString.lowercased()
        let messages = BridgeMessages(nonce: nonce, cache: cache)
        let seed = try ChooserFiles.create(in: cache)
        var controller: BridgeViewController?
        var window: UIWindow?
        weak var previousKeyWindow: UIWindow?
        defer {
            // Dropping both owners invokes CDVViewController's normal dealloc,
            // which disposes its command queue, web engine and loaded plugins.
            if let webView = controller?.webView as? WKWebView {
                webView.stopLoading()
                webView.configuration.userContentController.removeAllScriptMessageHandlers()
                webView.configuration.userContentController.removeAllUserScripts()
                webView.navigationDelegate = nil
                webView.uiDelegate = nil
                webView.removeFromSuperview()
            }
            window?.isHidden = true
            window?.rootViewController = nil
            controller?.messages = nil
            controller = nil
            window = nil
            previousKeyWindow?.makeKeyAndVisible()
            do {
                if try ChooserFiles.entryExists(seed) { try FileManager.default.removeItem(at: seed) }
            } catch {
                XCTFail("Seed cleanup failed: \(error)")
            }
            messages.record("teardown")
            XCTAssertEqual(messages.nonceErrors, 0, messages.diagnostic)
            XCTAssertTrue(messages.errors.isEmpty, messages.diagnostic)
        }

        let bytes: [UInt8] = [0, 127, 128, 255, 13, 10, 34, 92]
        try Data(bytes).write(to: seed)
        let id = seed.lastPathComponent
        XCTAssertTrue(ChooserFiles.isID(id))
        let authoritative: [String: Any] = [
            "id": id, "uri": seed.absoluteString, "size": bytes.count,
            "name": "Bridge \"seed\" ☃.bin", "mediaType": "application/octet-stream"
        ]
        var saved = authoritative
        saved["uri"] = "file:///stale-bridge-reference/\(id)"
        saved["size"] = bytes.count + 100
        // A released id would be rejected by the JS resource cache before exec.
        let missingID = UUID().uuidString.lowercased()
        let missingURL = seed.deletingLastPathComponent().appendingPathComponent(missingID)
        guard missingID != id, ChooserFiles.isID(missingID), try !ChooserFiles.entryExists(missingURL) else {
            throw BridgeFailure(description: "Expected a fresh, nonexistent managed UUID")
        }
        var missing = authoritative
        missing["id"] = missingID
        missing["uri"] = missingURL.absoluteString

        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = try XCTUnwrap(scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first)
        previousKeyWindow = scene.windows.first(where: { $0.isKeyWindow })
        let nonceJSON = String(decoding: try JSONSerialization.data(withJSONObject: [nonce]), as: UTF8.self)
        let startupDeadline = ProcessInfo.processInfo.systemUptime + 60
        controller = BridgeViewController()
        controller?.messages = messages
        controller?.nonceScript = "Object.defineProperty(window, '__chooserBridgeNonce', {value: \(nonceJSON)[0]});"
        controller?.startPage = "bridge.html"
        window = UIWindow(windowScene: scene)
        window?.rootViewController = controller
        window?.makeKeyAndVisible()
        controller?.loadViewIfNeeded()
        messages.record("startup")
        try await messages.wait(until: startupDeadline, phase: "Cordova startup (60 seconds)") {
            messages.readyCount == 1
        }
        XCTAssertTrue(window?.isKeyWindow == true && window?.isHidden == false)

        let arguments: [String: Any] = [
            "nonce": nonce, "reference": saved, "expected": authoritative,
            "bytes": bytes.map { Int($0) }, "missingReference": missing
        ]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: [arguments]), as: UTF8.self)
        let operationDeadline = ProcessInfo.processInfo.systemUptime + 30
        messages.running = true
        // The entry point returns a boolean immediately, never a JS Promise.
        // Async results and errors arrive exclusively through the nonce channel.
        messages.webView?.evaluateJavaScript("window.chooserBridgeRun.apply(null, \(json));") { value, error in
            if let error = error { messages.fail("JavaScript invocation threw: \(error)") }
            else if value as? Bool != true { messages.fail("JavaScript refused the operation sequence") }
            messages.invocationReturned = true
        }
        try await messages.wait(until: operationDeadline, phase: "Bridge operation sequence (30 seconds)") {
            messages.completionCount == 1 && messages.invocationReturned
        }
        let result = try XCTUnwrap(messages.completion)
        let restored = try XCTUnwrap(result["restored"] as? [String: Any])
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: restored, options: [.sortedKeys]),
                       try JSONSerialization.data(withJSONObject: authoritative, options: [.sortedKeys]))
        XCTAssertEqual(result["bytes"] as? [Int], bytes.map { Int($0) })
        XCTAssertEqual(result["steps"] as? [String], ["restore", "readRange", "release", "missingStat"])
        XCTAssertEqual(result["released"] as? Bool, true)
        let failure = try XCTUnwrap(result["missingError"] as? [String: Any])
        XCTAssertEqual(failure["isChooserError"] as? Bool, true)
        XCTAssertEqual(failure["code"] as? String, "FILE_UNAVAILABLE")
        XCTAssertEqual(failure["causeCode"] as? String, "FILE_UNAVAILABLE")
        XCTAssertFalse(try ChooserFiles.entryExists(seed), "Public release() must delete the native managed file")
        XCTAssertFalse(try ChooserFiles.entryExists(missingURL))
        XCTAssertEqual(messages.readyCount, 1, messages.diagnostic)
        XCTAssertEqual(messages.completionCount, 1, messages.diagnostic)
        messages.record("verified native deletion and public roundtrip")
    }
}
