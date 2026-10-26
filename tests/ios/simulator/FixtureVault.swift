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
        let staging = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: staging, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: staging) }
        for source in try manager.contentsOfDirectory(at: assets, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let destination = documents.appendingPathComponent(source.lastPathComponent)
            guard !manager.fileExists(atPath: destination.path) else {
                throw failure("Unexpected existing fixture: \(source.lastPathComponent)")
            }
            let temporary = staging.appendingPathComponent(source.lastPathComponent)
            let payload = try Data(contentsOf: source)
            let document = VaultDocument(fileURL: temporary, payload: payload)
            let saved = await withCheckedContinuation { continuation in
                document.save(to: temporary, for: .forCreating) { continuation.resume(returning: $0) }
            }
            guard saved else { throw failure("Could not save \(source.lastPathComponent)") }
            let closed = await withCheckedContinuation { continuation in
                document.close { continuation.resume(returning: $0) }
            }
            guard closed else { throw failure("Could not close \(source.lastPathComponent)") }
            // Let the document browser create the provider-managed source. Only
            // generated staging files are imported; bundled assets stay intact.
            let (imported, error): (URL?, Error?) = await withCheckedContinuation { continuation in
                revealDocument(at: temporary, importIfNeeded: true) { url, error in
                    continuation.resume(returning: (url, error))
                }
            }
            if let error = error { throw failure("Could not import \(source.lastPathComponent)", underlying: error) }
            guard let imported = imported,
                  imported.resolvingSymlinksInPath().standardizedFileURL == destination.resolvingSymlinksInPath().standardizedFileURL else {
                throw failure("Fixture import did not return its expected private Documents URL: \(source.lastPathComponent)")
            }
            var coordinationError: NSError?
            var contents: Result<Data, Error>?
            NSFileCoordinator().coordinate(readingItemAt: imported, options: [], error: &coordinationError) { url in
                contents = Result { try Data(contentsOf: url) }
            }
            if let error = coordinationError { throw failure("Could not coordinate imported fixture", underlying: error) }
            guard let contents = contents, try contents.get() == payload else {
                throw failure("Fixture import changed bytes: \(source.lastPathComponent)")
            }
            NSLog("CHOOSER_VAULT imported %@", source.lastPathComponent)
        }
    }

    private func failure(_ message: String, underlying: Error? = nil) -> Error {
        var info: [String: Any] = [NSLocalizedDescriptionKey: message]
        if let underlying = underlying { info[NSUnderlyingErrorKey] = underlying }
        return NSError(domain: "ChooserFixture", code: 1, userInfo: info)
    }
}
