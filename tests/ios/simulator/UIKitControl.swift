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
    private weak var current: UIDocumentPickerViewController?
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
    private func pick(_ type: UTType) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [type], asCopy: true)
        picker.delegate = self
        probe.configure(picker)
        current = picker
        present(picker, animated: true) {
            picker.presentationController?.delegate = self
            self.probe.presented(picker)
        }
    }
    private func settle(_ picker: UIDocumentPickerViewController, _ value: String) {
        guard current === picker else { return }
        current = nil
        FixtureEvents.record("UIKit delegate \(value)")
        outcome.text = value
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        settle(controller, urls.first.map { "selected:\($0.lastPathComponent)" } ?? "error:empty native selection")
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        FixtureEvents.record("UIKit cancellation delegate")
        settle(controller, "canceled:1")
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        FixtureEvents.record("UIKit adaptive dismissal delegate")
        if let picker = presentationController.presentedViewController as? UIDocumentPickerViewController {
            documentPickerWasCancelled(picker)
        }
    }
}
