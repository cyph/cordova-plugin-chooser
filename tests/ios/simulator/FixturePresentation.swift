import UIKit

@MainActor
final class FixturePresentation {
    private var serial = 0

    func configure(_ picker: UIDocumentPickerViewController) {
        if ProcessInfo.processInfo.environment["CHOOSER_TEST_SHEET"] == "1" {
            picker.modalPresentationStyle = .pageSheet
            picker.isModalInPresentation = false
            if let sheet = picker.sheetPresentationController {
                sheet.detents = [.medium(), .large()]
                sheet.selectedDetentIdentifier = .medium
                sheet.prefersGrabberVisible = true
            }
        }
    }

    func presented(_ picker: UIDocumentPickerViewController) {
        serial += 1
        let current = serial
        let presented = picker.presentationController?.presentedView ?? picker.view!
        let frame = presented.convert(presented.bounds, to: nil)
        let details: [String: Any] = ["serial": current, "x": frame.minX, "y": frame.minY,
            "width": frame.width, "height": frame.height, "beingPresented": picker.isBeingPresented,
            "beingDismissed": picker.isBeingDismissed, "style": picker.modalPresentationStyle.rawValue, "modalInPresentation": picker.isModalInPresentation,
            "detent": picker.sheetPresentationController?.selectedDetentIdentifier?.rawValue ?? "none"]
        let value = String(data: try! JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]), encoding: .utf8)!
        NSLog("CHOOSER_FIXTURE presented %@", value)
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

    private func observe(_ picker: UIDocumentPickerViewController, serial current: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self, weak picker] in
            guard let self = self, self.serial == current else { return }
            guard let picker = picker else {
                NSLog("CHOOSER_FIXTURE released serial=%d", current)
                return
            }
            if picker.isBeingDismissed || picker.presentingViewController == nil {
                NSLog("CHOOSER_FIXTURE dismissal serial=%d transitioning=%d", current, picker.isBeingDismissed ? 1 : 0)
            } else {
                self.observe(picker, serial: current)
            }
        }
    }
}
