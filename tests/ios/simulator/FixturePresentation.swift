import UIKit

@MainActor
enum FixtureEvents {
    private static let output = DispatchQueue(label: "com.cyph.chooser.fixture-events", qos: .utility)

    static func record(_ message: String, completion: (@MainActor @Sendable (Bool) -> Void)? = nil) {
        NSLog("CHOOSER_FIXTURE %@", message)
        let fields: [String: Any] = ["case": ProcessInfo.processInfo.environment["CHOOSER_CASE"] ?? "native",
            "time": Date().timeIntervalSince1970, "message": message]
        guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else {
            completion?(false)
            return
        }
        let path = cache.appendingPathComponent("chooser-fixture-events.log")
        let line = data + Data([10])
        // Disk writes must not serialize UI callbacks or immediate reopening.
        output.async {
            let recorded: Bool
            do {
                let manager = FileManager.default
                try manager.createDirectory(at: cache, withIntermediateDirectories: true)
                if !manager.fileExists(atPath: path.path) { _ = manager.createFile(atPath: path.path, contents: nil) }
                let handle = try FileHandle(forWritingTo: path)
                defer { try? handle.close() }
                _ = try handle.seekToEnd()
                try handle.write(contentsOf: line)
                recorded = true
            } catch {
                NSLog("CHOOSER_FIXTURE event recording failed: %@", String(describing: error))
                recorded = false
            }
            if let completion = completion {
                DispatchQueue.main.async { completion(recorded) }
            }
        }
    }
}

@MainActor
final class FixturePresentation {
    private var serial = 0

    func configure(_ picker: UIViewController) {
        // Document pickers keep all production presentation defaults, including
        // the system's choice of whether to show a grabber.
        guard !(picker is UIDocumentPickerViewController),
              ProcessInfo.processInfo.environment["CHOOSER_TEST_SHEET"] == "1" else { return }
        picker.modalPresentationStyle = .pageSheet
        picker.isModalInPresentation = false
        if let sheet = picker.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.selectedDetentIdentifier = .medium
            sheet.prefersGrabberVisible = true
        }
    }

    func presented(_ picker: UIViewController) {
        serial += 1
        let details: [String: Any] = ["serial": serial,
            "delegate": (picker as? UIDocumentPickerViewController)?.delegate.map { String(describing: type(of: $0)) } ?? "nil",
            "presentationDelegate": picker.presentationController?.delegate.map { String(describing: type(of: $0)) } ?? "nil"]
        let value = String(data: try! JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]), encoding: .utf8)!
        FixtureEvents.record("presented \(value)")
    }
}
