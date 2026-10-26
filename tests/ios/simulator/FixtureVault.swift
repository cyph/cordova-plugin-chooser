import UIKit
import UniformTypeIdentifiers

private final class VaultDocument: UIDocument {
    let payload: Data
    init(fileURL: URL, payload: Data) {
        self.payload = payload
        super.init(fileURL: fileURL)
    }
    override func contents(forType typeName: String) throws -> Any { payload }
}

@main
final class VaultApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "FixtureVault", sessionRole: session.role)
        configuration.delegateClass = VaultScene.self
        return configuration
    }
}

final class VaultScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let controller = VaultBrowser(forOpening: [.item])
        controller.allowsDocumentCreation = false
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
    }
}

private final class VaultBrowser: UIDocumentBrowserViewController {
    private var started = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { @MainActor in
            let status: [String: String]
            do {
                try await seed()
                status = ["status": "ready"]
            } catch {
                NSLog("CHOOSER_VAULT initialization failed: %@", String(describing: error))
                status = ["status": "failed", "error": String(describing: error)]
            }
            let manager = FileManager.default
            let cache = manager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            try! manager.createDirectory(at: cache, withIntermediateDirectories: true)
            try! JSONSerialization.data(withJSONObject: status).write(to: cache.appendingPathComponent("chooser-fixture-ready"), options: .atomic)
        }
    }

    private func seed() async throws {
        let manager = FileManager.default
        let documents = manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try manager.createDirectory(at: documents, withIntermediateDirectories: true)
        let assets = Bundle.main.url(forResource: "Assets", withExtension: nil)!
        for source in try manager.contentsOfDirectory(at: assets, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let destination = documents.appendingPathComponent(source.lastPathComponent)
            if !manager.fileExists(atPath: destination.path) {
                let document = VaultDocument(fileURL: destination, payload: try Data(contentsOf: source))
                let saved = await withCheckedContinuation { continuation in
                    document.save(to: destination, for: .forCreating) { continuation.resume(returning: $0) }
                }
                guard saved else { throw failure("Could not save \(source.lastPathComponent)") }
                let closed = await withCheckedContinuation { continuation in
                    document.close { continuation.resume(returning: $0) }
                }
                guard closed else { throw failure("Could not close \(source.lastPathComponent)") }
            }
            // A completed save proves the file exists. Also require the source
            // browser to reveal it without importing or replacing the original.
            let error: Error? = await withCheckedContinuation { continuation in
                revealDocument(at: destination, importIfNeeded: false) { _, error in
                    continuation.resume(returning: error)
                }
            }
            if let error = error { throw error }
            NSLog("CHOOSER_VAULT revealed %@", source.lastPathComponent)
        }
    }

    private func failure(_ message: String) -> Error {
        NSError(domain: "ChooserFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
