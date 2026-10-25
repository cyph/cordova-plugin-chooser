import UIKit

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
        let manager = FileManager.default
        let documents = manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try! manager.createDirectory(at: documents, withIntermediateDirectories: true)
        let assets = Bundle.main.url(forResource: "Assets", withExtension: nil)!
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        Task { @MainActor in
            for source in try! manager.contentsOfDirectory(at: assets, includingPropertiesForKeys: nil) {
                let destination = documents.appendingPathComponent(source.lastPathComponent)
                if manager.fileExists(atPath: destination.path) { continue }
                let document = VaultDocument(fileURL: destination, payload: try! Data(contentsOf: source))
                let saved = await withCheckedContinuation { continuation in
                    document.save(to: destination, for: .forCreating) { continuation.resume(returning: $0) }
                }
                precondition(saved, "Could not save fixture document")
                let closed = await withCheckedContinuation { continuation in
                    document.close { continuation.resume(returning: $0) }
                }
                precondition(closed, "Could not close fixture document")
            }
            let cache = manager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            try! manager.createDirectory(at: cache, withIntermediateDirectories: true)
            try! Data("ready".utf8).write(to: cache.appendingPathComponent("chooser-fixture-ready"), options: .atomic)
        }
    }
}
