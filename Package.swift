// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CordovaPluginChooser",
    platforms: [.iOS(.v15)],
    products: [.library(name: "CordovaPluginChooser", targets: ["CordovaPluginChooser"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
    targets: [
        .target(
            name: "CordovaPluginChooser",
            dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")],
            path: ".",
            exclude: ["src/ios/CordovaChooser.swift"],
            sources: [
                "capacitor/ios/CapacitorChooser.swift",
                "src/ios/Chooser.swift",
                "src/ios/ChooserBudget.swift",
                "src/ios/ChooserError.swift",
                "src/ios/ChooserFiles.swift",
                "src/ios/ChooserPhotos.swift",
                "src/ios/ChooserRequest.swift",
                "src/ios/ChooserResources.swift",
                "src/ios/ChooserTransaction.swift",
                "src/ios/ChooserTypes.swift",
                "src/ios/ChooserWork.swift"
            ],
            resources: [.copy("src/ios/ChooserPrivacy.bundle")]
        )
    ]
)
