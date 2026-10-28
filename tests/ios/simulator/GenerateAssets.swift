import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

private enum FixtureError: Error { case invalid(String) }

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw FixtureError.invalid(message) }
}

@main
struct GenerateAssets {
    static func main() async throws {
        try require(CommandLine.arguments.count > 1, "Expected an asset directory or --identities")
        if CommandLine.arguments[1] == "--identities" {
            let records = CommandLine.arguments.dropFirst(2).map(identity)
            let result: [String: Any] = [
                "schema": 1, "time": Date().timeIntervalSince1970, "files": records
            ]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
            return
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{\"fixture\":true}".utf8).write(to: directory.appendingPathComponent("fixture-json.json"))
        try Data("a,b\n1,2\n".utf8).write(to: directory.appendingPathComponent("fixture-csv.csv"))
        try image(directory.appendingPathComponent("fixture-image.png"))
        try pdf(directory.appendingPathComponent("fixture-pdf.pdf"))
        try await movie(directory.appendingPathComponent("fixture-mp4.mp4"), type: .mp4)
        try await movie(directory.appendingPathComponent("fixture-mov.mov"), type: .mov)
        print("Generated and decoded PNG, PDF, MP4, and MOV fixtures.")
    }

    private static func identity(_ path: String) -> [String: Any] {
        let manager = FileManager.default
        let url = URL(fileURLWithPath: path)
        let exists = manager.fileExists(atPath: path)
        var record: [String: Any] = ["path": path, "exists": exists]
        guard exists else { return record }
        // These are host filesystem observations, not provider identifiers.
        // Preserve opaque values and large integers without JSON rounding.
        func describe(_ value: Any?) -> Any {
            guard let value = value else { return NSNull() }
            if let data = value as? Data { return data.base64EncodedString() }
            if let number = value as? NSNumber { return number.stringValue }
            return String(describing: value)
        }
        do {
            let attributes = try manager.attributesOfItem(atPath: path)
            for (name, key) in [
                ("device", FileAttributeKey.systemNumber),
                ("inode", .systemFileNumber), ("size", .size),
                ("permissions", .posixPermissions), ("type", .type)
            ] {
                record[name] = describe(attributes[key])
            }
        } catch { record["attributesError"] = String(describing: error) }
        do {
            let keys: [(String, URLResourceKey)] = [
                ("documentIdentifier", .documentIdentifierKey),
                ("fileResourceIdentifier", .fileResourceIdentifierKey),
                ("volumeIdentifier", .volumeIdentifierKey),
                ("volumeUUID", .volumeUUIDStringKey),
                ("volumeFormat", .volumeLocalizedFormatDescriptionKey),
                ("volumeIsLocal", .volumeIsLocalKey),
                ("volumeIsReadOnly", .volumeIsReadOnlyKey)
            ]
            let values = try url.resourceValues(forKeys: Set(keys.map { $0.1 })).allValues
            for (name, key) in keys { record[name] = describe(values[key]) }
        } catch { record["resourceError"] = String(describing: error) }
        return record
    }

    private static func image(_ url: URL) throws {
        let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8,
            bytesPerRow: 256, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0, green: 0.3, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        try require(CGImageDestinationFinalize(destination), "PNG encoding failed")
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        try require(CGImageSourceCreateImageAtIndex(source, 0, nil) != nil, "PNG decoding failed")
    }

    private static func pdf(_ url: URL) throws {
        var bounds = CGRect(x: 0, y: 0, width: 64, height: 64)
        let context = CGContext(url as CFURL, mediaBox: &bounds, nil)!
        context.beginPDFPage(nil)
        context.setFillColor(CGColor(gray: 0.5, alpha: 1))
        context.fill(bounds)
        context.endPDFPage()
        context.closePDF()
        try require(CGPDFDocument(url as CFURL)?.numberOfPages == 1, "PDF decoding failed")
    }

    // The adaptor API supports the macOS 15 runner baseline as well as newer SDKs.
    private static func movie(_ url: URL, type: AVFileType) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: type)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 64, AVVideoHeightKey: 64
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64
            ])
        try require(writer.canAdd(input), "Unsupported video input")
        writer.add(input)
        try require(writer.startWriting(), "Video writer did not start: \(String(describing: writer.error))")
        writer.startSession(atSourceTime: .zero)
        var optionalBuffer: CVPixelBuffer?
        try require(CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32ARGB,
            nil, &optionalBuffer) == kCVReturnSuccess, "Pixel buffer allocation failed")
        let buffer = optionalBuffer!
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddress(buffer)!, 0x80, CVPixelBufferGetBytesPerRow(buffer) * 64)
        CVPixelBufferUnlockBaseAddress(buffer, [])
        for frame in 0..<2 {
            let deadline = Date().addingTimeInterval(15)
            while !input.isReadyForMoreMediaData && writer.status == .writing && Date() < deadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            try require(input.isReadyForMoreMediaData, "Video input stalled: \(String(describing: writer.error))")
            try require(adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 2)),
                "Video frame rejected: \(String(describing: writer.error))")
        }
        writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1))
        input.markAsFinished()
        await writer.finishWriting()
        try require(writer.status == .completed, "Video encoding failed: \(String(describing: writer.error))")
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        try require(tracks.count == 1, "Generated movie has no video track")
        let duration = try await asset.load(.duration)
        try require(duration.seconds > 0, "Generated movie is empty")
    }
}
