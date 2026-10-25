import Foundation
import MobileCoreServices
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

enum ChooserTypes {
	static func identifiers(for accept: String) -> [String] {
		var identifiers = accept.components(separatedBy: ",").map { mime in
			// Movie includes audiovisual formats which public.video alone may exclude.
			let wildcards = [
				"audio/*": "public.audio", "font/*": "public.font",
				"image/*": "public.image", "text/*": "public.text", "video/*": "public.movie"
			]
			if let identifier = wildcards[mime] { return identifier }
			if mime.contains("*") || mime.isEmpty { return "public.item" }
			#if canImport(UniformTypeIdentifiers)
			if #available(iOS 14.0, *) {
				if let type = UTType(mimeType: mime), !type.isDynamic { return type.identifier }
				return "public.item"
			}
			else { return legacyIdentifier(for: mime) }
			#else
			return legacyIdentifier(for: mime)
			#endif
		}
		// Compatibility aliases cover older iWork document registrations.
		for (legacy, alternate) in [
			("com.apple.iwork.pages.sffpages", "com.apple.iwork.pages.pages"),
			("com.apple.iwork.numbers.sffnumbers", "com.apple.iwork.numbers.numbers")
		] where identifiers.contains(legacy) && !identifiers.contains(alternate) {
			identifiers.append(alternate)
		}
		return identifiers
	}

	@available(iOS, introduced: 11.0, deprecated: 14.0)
	private static func legacyIdentifier(for mime: String) -> String {
		if let identifier = UTTypeCreatePreferredIdentifierForTag(kUTTagClassMIMEType, mime as CFString, nil)?.takeRetainedValue() as String?,
			!identifier.hasPrefix("dyn.") { return identifier }
		return "public.item"
	}

	static func mediaType(for url: URL) -> String {
		#if canImport(UniformTypeIdentifiers)
		if #available(iOS 14.0, *) {
			return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
		}
		else { return legacyMediaType(for: url) }
		#else
		return legacyMediaType(for: url)
		#endif
	}

	@available(iOS, introduced: 11.0, deprecated: 14.0)
	private static func legacyMediaType(for url: URL) -> String {
		if let uti = UTTypeCreatePreferredIdentifierForTag(kUTTagClassFilenameExtension, url.pathExtension as CFString, nil)?.takeRetainedValue(),
			let type = UTTypeCopyPreferredTagWithClass(uti, kUTTagClassMIMEType)?.takeRetainedValue() as String? {
			return type
		}
		return "application/octet-stream"
	}

}
