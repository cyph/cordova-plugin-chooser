import UIKit
import WebKit
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

final class FixtureController: CDVViewController {
    let outcome = UILabel()
    private var messages: FixtureMessages?
    static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    override func viewDidLoad() {
        startPage = "index.html"
        super.viewDidLoad()
        let files = ["fixture-json.json": "{\"fixture\":true}", "fixture-csv.csv": "a,b\n1,2\n",
                     "fixture-pdf.pdf": "%PDF-1.4\n%%EOF", "fixture-mp4.mp4": "synthetic movie type fixture",
                     "fixture-mov.mov": "synthetic movie type fixture"]
        for (name, contents) in files {
            try! Data(contents.utf8).write(to: Self.documents.appendingPathComponent(name))
        }
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zAAAAABJRU5ErkJggg==")!
        try! png.write(to: Self.documents.appendingPathComponent("fixture-image.png"))
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
    override func present(_ controller: UIViewController, animated: Bool, completion: (() -> Void)? = nil) {
        if let picker = controller as? UIDocumentPickerViewController {
            picker.directoryURL = Self.documents
            // Force the historical adaptive sheet route only in this fixture.
            if ProcessInfo.processInfo.environment["CHOOSER_TEST_SHEET"] == "1" {
                picker.modalPresentationStyle = .pageSheet
            }
        }
        super.present(controller, animated: animated, completion: completion)
    }
}
