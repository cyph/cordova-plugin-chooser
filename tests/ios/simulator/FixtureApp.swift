import UIKit
import WebKit
import Cordova

@main
final class FixtureApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = FixtureController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class FixtureController: CDVViewController, WKScriptMessageHandler {
    let outcome = UILabel()
    static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    override func viewDidLoad() {
        startPage = "index.html"
        super.viewDidLoad()
        let files = ["sample.json": "{\"fixture\":true}", "sample.csv": "a,b\n1,2\n",
                     "sample.pdf": "%PDF-1.4\n%%EOF", "sample.mp4": "synthetic movie type fixture",
                     "sample.mov": "synthetic movie type fixture"]
        for (name, contents) in files {
            try! Data(contents.utf8).write(to: Self.documents.appendingPathComponent(name))
        }
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zAAAAABJRU5ErkJggg==")!
        try! png.write(to: Self.documents.appendingPathComponent("sample.png"))
        (webView as! WKWebView).configuration.userContentController.add(self, name: "fixture")
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
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        outcome.text = message.body as? String
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
