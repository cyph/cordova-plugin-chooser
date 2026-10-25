import Foundation

@main
enum InspectSources {
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let manager = FileManager.default
        let keys: [(String, URLResourceKey)] = [
            ("documentIdentifier", .documentIdentifierKey),
            ("fileIdentifier", .fileResourceIdentifierKey),
            ("volumeIdentifier", .volumeIdentifierKey),
            ("persistentIdsSupported", .volumeSupportsPersistentIDsKey),
            ("readable", .isReadableKey),
            ("writable", .isWritableKey)
        ]
        let files = try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let rows: [[String: Any]] = files.sorted { $0.lastPathComponent < $1.lastPathComponent }.map { url in
            var row: [String: Any] = ["name": url.lastPathComponent]
            for (name, key) in keys {
                do {
                    var value: AnyObject?
                    try (url as NSURL).getResourceValue(&value, forKey: key)
                    row[name] = value.map { String(describing: $0) } ?? "unavailable"
                } catch {
                    row[name] = ["error": String(describing: error)]
                }
            }
            return row
        }
        let attributes = try manager.attributesOfFileSystem(forPath: directory.path)
        let volume = Dictionary(uniqueKeysWithValues: attributes.map { ($0.key.rawValue, String(describing: $0.value)) })
        let payload: [String: Any] = ["volume": volume, "files": rows]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
    }
}
