import UIKit
import WebKit
import UniformTypeIdentifiers
#if canImport(Cordova)
import Cordova
#endif

@main
final class FixtureApp: UIResponder, UIApplicationDelegate {
    // Keep the conventional delegate window available to older Cordova code.
    var window: UIWindow?
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "ChooserFixture", sessionRole: session.role)
        configuration.delegateClass = FixtureScene.self
        return configuration
    }
}

final class FixtureScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = FixtureController()
        window.makeKeyAndVisible()
        self.window = window
        (UIApplication.shared.delegate as? FixtureApp)?.window = window
    }
}

@MainActor
private final class FixtureMessages: NSObject, WKScriptMessageHandler {
    weak var owner: FixtureController?
    init(owner: FixtureController) { self.owner = owner }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "fixture" { owner?.outcome.text = message.body as? String }
    }
}

final class FixtureController: CDVViewController, UIDocumentPickerDelegate {
    let outcome = UILabel()
    private var messages: FixtureMessages?
    override func viewDidLoad() {
        startPage = "index.html"
        super.viewDidLoad()
        // Conforming the controller itself would opt into Cordova's bridge
        // override hook. Keep this test-only channel on a separate handler.
        let messages = FixtureMessages(owner: self)
        self.messages = messages
        (webView as! WKWebView).configuration.userContentController.add(messages, name: "fixture")
        let controls = UIStackView()
        controls.axis = .vertical
        controls.backgroundColor = .systemBackground
        for (title, filter) in [("Choose", "*/*"), ("JSON", "application/json"), ("CSV", "text/csv"),
                                ("PDF", "application/pdf"), ("Image", "image/*"), ("Video", "video/*")] {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.accessibilityIdentifier = title
            button.addAction(UIAction { [weak self] _ in
                if ProcessInfo.processInfo.environment["CHOOSER_NATIVE_CONTROL"] == "1" {
                    self?.pickNative(filter)
                    return
                }
                let argument = String(data: try! JSONSerialization.data(withJSONObject: [filter]), encoding: .utf8)!
                (self?.webView as? WKWebView)?.evaluateJavaScript("window.pick(\(argument)[0])", completionHandler: nil)
            }, for: .touchUpInside)
            controls.addArrangedSubview(button)
        }
        outcome.accessibilityIdentifier = "Outcome"
        outcome.text = "loading"
        controls.addArrangedSubview(outcome)
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            controls.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }
    private func pickNative(_ filter: String) {
        let types: [String: UTType] = [
            "application/json": .json, "text/csv": .commaSeparatedText,
            "application/pdf": .pdf, "image/*": .image, "video/*": .movie
        ]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [types[filter] ?? .item], asCopy: true)
        picker.delegate = self
        present(picker, animated: true)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else {
            outcome.text = "error:empty native selection"
            return
        }
        outcome.text = "selected:\(url.lastPathComponent)"
    }
    override func present(_ controller: UIViewController, animated: Bool, completion: (() -> Void)? = nil) {
        if let picker = controller as? UIDocumentPickerViewController {
            // Force the historical adaptive sheet route only in this fixture.
            if ProcessInfo.processInfo.environment["CHOOSER_TEST_SHEET"] == "1" {
                picker.modalPresentationStyle = .pageSheet
                if let sheet = picker.sheetPresentationController {
                    sheet.detents = [.medium(), .large()]
                    sheet.selectedDetentIdentifier = .medium
                    sheet.prefersGrabberVisible = true
                }
            }
        }
        super.present(controller, animated: animated, completion: completion)
    }
}
