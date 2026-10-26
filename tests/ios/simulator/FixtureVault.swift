import UIKit

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
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        Task { @MainActor in
            let status: [String: String]
            do {
                try seed()
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

    @MainActor
    private func seed() throws {
        let manager = FileManager.default
        let documents = manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try manager.createDirectory(at: documents, withIntermediateDirectories: true)
        let assets = Bundle.main.url(forResource: "Assets", withExtension: nil)!
        for source in try manager.contentsOfDirectory(at: assets, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let destination = documents.appendingPathComponent(source.lastPathComponent)
            guard !manager.fileExists(atPath: destination.path) else {
                throw NSError(domain: "ChooserFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unexpected existing fixture: \(source.lastPathComponent)"])
            }
            var coordinationError: NSError?
            var copied: Result<Void, Error>?
            // Create each source as a new file in the app's shared Documents
            // directory, coordinating its creation and verifying the copied bytes.
            NSFileCoordinator().coordinate(writingItemAt: destination, options: [], error: &coordinationError) { url in
                copied = Result {
                    try manager.copyItem(at: source, to: url)
                    guard try Data(contentsOf: url) == Data(contentsOf: source) else {
                        throw NSError(domain: "ChooserFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Fixture copy changed bytes: \(source.lastPathComponent)"])
                    }
                }
            }
            if let error = coordinationError { throw error }
            guard let copied = copied else {
                throw NSError(domain: "ChooserFixture", code: 3, userInfo: [NSLocalizedDescriptionKey: "File coordination returned no result"])
            }
            try copied.get()
            NSLog("CHOOSER_VAULT created %@", source.lastPathComponent)
        }
    }
}
