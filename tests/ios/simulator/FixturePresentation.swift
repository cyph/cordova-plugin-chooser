import UIKit

@MainActor
enum FixtureEvents {
    private static let output = DispatchQueue(label: "com.cyph.chooser.fixture-events", qos: .utility)

    static func record(_ message: String) {
        NSLog("CHOOSER_FIXTURE %@", message)
        let fields: [String: Any] = ["case": ProcessInfo.processInfo.environment["CHOOSER_CASE"] ?? "native",
            "time": Date().timeIntervalSince1970, "message": message]
        guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return }
        let path = cache.appendingPathComponent("chooser-fixture-events.log")
        let line = data + Data([10])
        // Disk writes must not serialize UI callbacks or immediate reopening.
        output.async {
            do {
                let manager = FileManager.default
                try manager.createDirectory(at: cache, withIntermediateDirectories: true)
                if !manager.fileExists(atPath: path.path) { _ = manager.createFile(atPath: path.path, contents: nil) }
                let handle = try FileHandle(forWritingTo: path)
                defer { try? handle.close() }
                _ = try handle.seekToEnd()
                try handle.write(contentsOf: line)
            } catch { NSLog("CHOOSER_FIXTURE event recording failed: %@", String(describing: error)) }
        }
    }
}

@MainActor
final class FixturePresentation {
    private var serial = 0

    func configure(_ picker: UIViewController) {
        if ProcessInfo.processInfo.environment["CHOOSER_TEST_SHEET"] == "1" {
            // Keep document-picker policy and detents identical to production.
            // Only the plain UIKit gesture control requests a custom sheet.
            if !(picker is UIDocumentPickerViewController) {
                picker.modalPresentationStyle = .pageSheet
                picker.isModalInPresentation = false
                if let sheet = picker.sheetPresentationController {
                    sheet.detents = [.medium(), .large()]
                    sheet.selectedDetentIdentifier = .medium
                }
            }
            if let sheet = picker.sheetPresentationController {
                sheet.prefersGrabberVisible = true
            }
        }
    }

    func presented(_ picker: UIViewController) {
        serial += 1
        let current = serial
        let presented = picker.presentationController?.presentedView ?? picker.view!
        let frame = presented.convert(presented.bounds, to: nil)
        let details: [String: Any] = ["serial": current, "x": frame.minX, "y": frame.minY,
            "width": frame.width, "height": frame.height, "beingPresented": picker.isBeingPresented,
            "beingDismissed": picker.isBeingDismissed, "style": picker.modalPresentationStyle.rawValue, "modalInPresentation": picker.isModalInPresentation,
            "detent": picker.sheetPresentationController?.selectedDetentIdentifier?.rawValue ?? "none",
            "delegate": (picker as? UIDocumentPickerViewController)?.delegate.map { String(describing: type(of: $0)) } ?? "nil",
            "presentationDelegate": picker.presentationController?.delegate.map { String(describing: type(of: $0)) } ?? "nil",
            "presentationControllers": presentationState(picker)]
        let value = String(data: try! JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]), encoding: .utf8)!
        FixtureEvents.record("presented \(value)")
        // The marker is attached only after UIKit and the plugin's presentation
        // completions have run. It neither replaces delegates nor handles input.
        let marker = UILabel(frame: CGRect(x: picker.view.bounds.midX, y: picker.view.bounds.height - 12, width: 1, height: 1))
        marker.isAccessibilityElement = true
        marker.accessibilityIdentifier = "PickerReady"
        marker.accessibilityLabel = "PickerReady"
        marker.accessibilityValue = value
        marker.text = "."
        marker.isUserInteractionEnabled = false
        picker.view.addSubview(marker)
        observe(picker, serial: current)
    }

    private func presentationState(_ picker: UIViewController) -> String {
        let original = picker.presentationController
        let active: UIPresentationController?
        if #available(iOS 16.0, *) { active = picker.activePresentationController }
        else { active = original }
        func describe(_ controller: UIPresentationController?) -> String {
            guard let controller = controller else { return "nil" }
            let delegate = controller.delegate.map { String(describing: type(of: $0)) } ?? "nil"
            let detent = (controller as? UISheetPresentationController)?.selectedDetentIdentifier?.rawValue ?? "none"
            return "\(type(of: controller)) frame=\(controller.frameOfPresentedViewInContainerView) detent=\(detent) delegate=\(delegate)"
        }
        return "same=\(original === active) original=[\(describe(original))] active=[\(describe(active))] policy=[\(dismissalPolicy(picker))]"
    }

    func dismissalPolicy(_ controller: UIViewController) -> String {
        var visited = Set<ObjectIdentifier>()
        func describe(_ value: UIViewController) -> String {
            guard visited.insert(ObjectIdentifier(value)).inserted else { return "visited" }
            let children = value.children.map(describe).joined(separator: "; ")
            let presented = value.presentedViewController.map(describe) ?? "none"
            return "\(type(of: value)) modal=\(value.isModalInPresentation) dismissing=\(value.isBeingDismissed) children=[\(children)] presented=[\(presented)]"
        }
        return describe(controller)
    }

    private func observe(_ picker: UIViewController, serial current: Int, previous: String = "") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self, weak picker] in
            guard let self = self, self.serial == current else { return }
            guard let picker = picker else {
                FixtureEvents.record("released serial=\(current)")
                return
            }
            let frame = picker.presentationController?.frameOfPresentedViewInContainerView ?? .null
            let delegate = picker.presentationController?.delegate.map { String(describing: type(of: $0)) } ?? "nil"
            let state = "frame=\(frame) detent=\(picker.sheetPresentationController?.selectedDetentIdentifier?.rawValue ?? "none") presenting=\(picker.presentingViewController != nil) dismissing=\(picker.isBeingDismissed) interactive=\(picker.transitionCoordinator?.isInteractive == true) delegate=\(delegate) \(self.presentationState(picker))"
            if state != previous { FixtureEvents.record("state serial=\(current) \(state)") }
            if picker.isBeingDismissed || picker.presentingViewController == nil {
                FixtureEvents.record("dismissal serial=\(current) transitioning=\(picker.isBeingDismissed)")
            } else {
                self.observe(picker, serial: current, previous: state)
            }
        }
    }
}
