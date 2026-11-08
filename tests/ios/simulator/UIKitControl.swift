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

private final class FixtureSheet: UINavigationController, UISheetPresentationControllerDelegate {
    var onDismissal: (@MainActor (UIViewController) -> Void)?

    // Observe the app-owned sheet without changing dismissal policy, forcing
    // layout, or loading a view just to collect diagnostics.
    func recordState(_ phase: String, presentation: UIPresentationController? = nil) {
        let presentation = presentation ?? presentationController
        let sheet = presentation as? UISheetPresentationController
        let frame = viewIfLoaded.flatMap { view in
            view.window.map { view.convert(view.bounds, to: $0) }
        }
        let details: [String: Any] = [
            "phase": phase,
            "detent": sheet?.selectedDetentIdentifier?.rawValue ?? "nil",
            "frameInWindow": frame.map { NSCoder.string(for: $0) } ?? "nil",
            "presentedFrameInContainer": presentation.map { NSCoder.string(for: $0.frameOfPresentedViewInContainerView) } ?? "nil",
            "containerBounds": presentation?.containerView.map { NSCoder.string(for: $0.bounds) } ?? "nil",
            "inWindow": viewIfLoaded?.window != nil,
            "hasPresenter": presentingViewController != nil,
            "isBeingPresented": isBeingPresented,
            "isBeingDismissed": isBeingDismissed,
            "isModalInPresentation": isModalInPresentation,
            "hasTransition": transitionCoordinator != nil,
            "transitionInteractive": transitionCoordinator?.isInteractive ?? false
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8) else { return }
        FixtureEvents.record("plainSheet \(value)")
    }

    func presentationControllerWillDismiss(_ presentationController: UIPresentationController) {
        recordState("willDismiss", presentation: presentationController)
        transitionCoordinator?.notifyWhenInteractionChanges { [weak self] context in
            let canceled = context.isCancelled
            // Preserve the transition result now; read UIKit state on the main
            // actor without retaining the coordinator context across the hop.
            Task { @MainActor [weak self] in
                self?.recordState("interactionChanged canceled=\(canceled)")
            }
        }
    }

    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
        recordState("didAttemptToDismiss", presentation: presentationController)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        recordState("didDismiss", presentation: presentationController)
        onDismissal?(self)
    }

    func sheetPresentationControllerDidChangeSelectedDetentIdentifier(_ sheetPresentationController: UISheetPresentationController) {
        recordState("detentChanged", presentation: sheetPresentationController)
    }
}

final class UIKitControlController: UIViewController, UIDocumentPickerDelegate {
    private let outcome = UILabel()
    private let probe = FixturePresentation()
    private weak var current: UIViewController?
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
        let sheet = FixtureSheet(rootViewController: content)
        sheet.onDismissal = { [weak self] controller in self?.settle(controller, "canceled:1") }
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
        present(picker, animated: true) {
            let original = picker.presentationController?.delegate.map { String(describing: type(of: $0)) } ?? "nil"
            // The native document-picker reference preserves UIKit's delegate.
            // The plain sheet needs our delegate to report its own dismissal.
            let replace = picker is FixtureSheet
            FixtureEvents.record("UIKit original presentation delegate=\(original) replaced=\(replace)")
            if let sheet = picker as? FixtureSheet { sheet.presentationController?.delegate = sheet }
            self.probe.presented(picker)
            (picker as? FixtureSheet)?.recordState("presented")
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
}
