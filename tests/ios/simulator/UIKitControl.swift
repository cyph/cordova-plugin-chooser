import UIKit
import UniformTypeIdentifiers

@main
final class UIKitControlApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "UIKitControl", sessionRole: session.role)
        configuration.delegateClass = UIKitControlScene.self
        return configuration
    }
}

final class UIKitControlScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIKitControlController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class UIKitControlController: UIViewController, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private let outcome = UILabel()
    private let probe = FixturePresentation()
    private weak var current: UIViewController?
    private var recordedDismissalPermission = false
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let controls = UIStackView()
        controls.axis = .vertical
        for (name, type) in [("Choose", UTType.item), ("JSON", .json), ("CSV", .commaSeparatedText),
                             ("PDF", .pdf), ("Image", .image), ("Video", .movie)] {
            let button = UIButton(type: .system)
            button.setTitle(name, for: .normal)
            button.accessibilityIdentifier = name
            button.addAction(UIAction { [weak self] _ in self?.pick(type) }, for: .touchUpInside)
            controls.addArrangedSubview(button)
        }
        let sheet = UIButton(type: .system)
        sheet.setTitle("Plain sheet", for: .normal)
        sheet.accessibilityIdentifier = "PlainSheet"
        sheet.addAction(UIAction { [weak self] _ in self?.plainSheet() }, for: .touchUpInside)
        controls.addArrangedSubview(sheet)
        let systemDelegate = UIButton(type: .system)
        systemDelegate.setTitle("System dismissal delegate", for: .normal)
        systemDelegate.accessibilityIdentifier = "SystemDelegate"
        systemDelegate.addAction(UIAction { [weak self] _ in self?.pick(.item, observeDismissal: false) }, for: .touchUpInside)
        controls.addArrangedSubview(systemDelegate)
        let export = UIButton(type: .system)
        export.setTitle("Export fixture", for: .normal)
        export.accessibilityIdentifier = "ExportFixture"
        export.addAction(UIAction { [weak self] _ in self?.exportFixture() }, for: .touchUpInside)
        controls.addArrangedSubview(export)
        outcome.accessibilityIdentifier = "Outcome"
        outcome.text = "ready"
        controls.addArrangedSubview(outcome)
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            controls.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }
    private func pick(_ type: UTType, observeDismissal: Bool = true) {
        let asCopy = ProcessInfo.processInfo.environment["CHOOSER_PROVIDER_MODE"] != "open"
        FixtureEvents.record("UIKit opening type=\(type.identifier) asCopy=\(asCopy)")
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [type], asCopy: asCopy)
        picker.delegate = self
        showPicker(picker, observeDismissal: observeDismissal)
    }
    private func exportFixture() {
        do {
            let name = ProcessInfo.processInfo.environment["CHOOSER_EXPORT_FILE"] ?? "fixture-pdf.pdf"
            guard ["fixture-pdf.pdf", "fixture-json.json", "fixture-csv.csv", "fixture-image.png", "fixture-mp4.mp4", "fixture-mov.mov"].contains(name),
                  let assets = Bundle.main.url(forResource: "Assets", withExtension: nil) else {
                throw NSError(domain: "ChooserFixture", code: 1)
            }
            let source = assets.appendingPathComponent(name)
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("chooser-export", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let prefix = ProcessInfo.processInfo.environment["CHOOSER_EXPORT_SEED"] == "1" ? "" : "exported-"
            let copy = directory.appendingPathComponent("\(prefix)\(name)")
            if !FileManager.default.fileExists(atPath: copy.path) {
                // Create a new document without inheriting bundle file metadata.
                let bytes = try Data(contentsOf: source)
                try bytes.write(to: copy, options: .withoutOverwriting)
                FixtureEvents.record("UIKit export input \(copy.lastPathComponent) created from \(bytes.count) bytes")
            }
            let picker = UIDocumentPickerViewController(forExporting: [copy], asCopy: true)
            picker.delegate = self
            showPicker(picker)
        } catch { outcome.text = "error:\(error)" }
    }
    private func plainSheet() {
        let content = UIViewController()
        content.title = "Gesture control"
        content.view.backgroundColor = .systemBackground
        let sheet = UINavigationController(rootViewController: content)
        content.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Cancel", primaryAction: UIAction { [weak self, weak sheet] _ in
            guard let self = self, let sheet = sheet else { return }
            sheet.dismiss(animated: true) { self.settle(sheet, "canceled:1") }
        })
        showPicker(sheet)
    }
    private func showPicker(_ picker: UIViewController, observeDismissal: Bool = true) {
        current = picker
        // This control must leave UIKit presentation completely untouched,
        // including its adaptive delegate and view/accessibility hierarchy.
        guard observeDismissal, ProcessInfo.processInfo.environment["CHOOSER_SYSTEM_PROVIDER"] != "1" else {
            FixtureEvents.record("UIKit presentation observation disabled")
            present(picker, animated: true)
            return
        }
        probe.configure(picker)
        recordedDismissalPermission = false
        present(picker, animated: true) {
            let original = picker.presentationController?.delegate.map { String(describing: type(of: $0)) } ?? "nil"
            // The native document-picker reference preserves UIKit's delegate.
            // The plain sheet needs our delegate to report its own dismissal.
            let replace = !(picker is UIDocumentPickerViewController)
            FixtureEvents.record("UIKit original presentation delegate=\(original) replaced=\(replace)")
            if replace { picker.presentationController?.delegate = self }
            self.probe.presented(picker)
        }
    }
    private func settle(_ picker: UIViewController, _ value: String) {
        guard current === picker else { return }
        current = nil
        FixtureEvents.record("UIKit delegate \(value)") { [weak self] recorded in
            self?.outcome.text = recorded ? value : "error:fixture event recording failed"
        }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        settle(controller, urls.first.map { "selected:\($0.lastPathComponent)" } ?? "error:empty native selection")
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        FixtureEvents.record("UIKit cancellation delegate")
        settle(controller, "canceled:1")
    }
    func presentationControllerWillDismiss(_ presentationController: UIPresentationController) {
        FixtureEvents.record("UIKit adaptive dismissal will begin")
    }
    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool {
        // UIKit may query this repeatedly while tracking a gesture. Keep policy
        // inspection in the presentation observer, outside this callback.
        if !recordedDismissalPermission {
            recordedDismissalPermission = true
            FixtureEvents.record("UIKit permits adaptive dismissal")
        }
        return true
    }
    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
        FixtureEvents.record("UIKit adaptive dismissal attempt was prevented: \(probe.dismissalPolicy(presentationController.presentedViewController))")
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        FixtureEvents.record("UIKit adaptive dismissal delegate")
        if let picker = presentationController.presentedViewController as? UIDocumentPickerViewController {
            documentPickerWasCancelled(picker)
        } else {
            settle(presentationController.presentedViewController, "canceled:1")
        }
    }
}
