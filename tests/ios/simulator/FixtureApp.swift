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

@MainActor
private final class FixtureExport: NSObject, UIDocumentPickerDelegate {
    weak var owner: FixtureController?
    init(owner: FixtureController) { self.owner = owner }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        owner?.didExportFixtures()
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        owner?.outcome.text = "seed-cancelled"
    }
}

final class FixtureController: CDVViewController {
    let outcome = UILabel()
    private var messages: FixtureMessages?
    private var exporter: FixtureExport?
    static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    private var assets: [URL] {
        let directory = Bundle.main.url(forResource: "Assets", withExtension: nil)!
        return (try! FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil))
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
    @discardableResult
    private func updateIdentifiers() -> Bool {
        let manager = FileManager.default
        let sources = assets
        var identifiers: [String] = []
        for source in sources {
            let destination = Self.documents.appendingPathComponent(source.lastPathComponent)
            guard manager.fileExists(atPath: destination.path) else { continue }
            let attributes = try! manager.attributesOfItem(atPath: destination.path)
            let identifier = attributes[.systemFileNumber] as! NSNumber
            identifiers.append("\(source.lastPathComponent):\(identifier.uint64Value)")
        }
        outcome.accessibilityValue = identifiers.joined(separator: ",")
        return identifiers.count == sources.count
    }
    func didExportFixtures() {
        outcome.text = updateIdentifiers() ? "seeded" : "seed-error:unexpected-directory"
    }
    override func viewDidLoad() {
        startPage = "index.html"
        super.viewDidLoad()
        updateIdentifiers()
        // Conforming the controller itself would opt into Cordova's bridge
        // override hook. Keep this test-only channel on a separate handler.
        let messages = FixtureMessages(owner: self)
        self.messages = messages
        (webView as! WKWebView).configuration.userContentController.add(messages, name: "fixture")
        let controls = UIStackView()
        controls.axis = .vertical
        controls.backgroundColor = .systemBackground
        exporter = FixtureExport(owner: self)
        let seed = UIButton(type: .system)
        seed.setTitle("Seed", for: .normal)
        seed.accessibilityIdentifier = "Seed"
        seed.addAction(UIAction { [weak self] _ in
            guard let self = self else { return }
            let picker = UIDocumentPickerViewController(forExporting: self.assets, asCopy: true)
            picker.delegate = self.exporter
            self.present(picker, animated: true)
        }, for: .touchUpInside)
        controls.addArrangedSubview(seed)
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
