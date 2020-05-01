import UIKit
import MobileCoreServices
import Foundation


class ChooserUIDocumentPickerViewController : UIDocumentPickerViewController {
	var includeData: Bool = false
}

@objc(Chooser)
class Chooser : CDVPlugin {
	var commandCallback: String?

	func callPicker (includeData: Bool, utis: [String]) {
		let picker = ChooserUIDocumentPickerViewController(documentTypes: utis, in: .import)
		picker.delegate = self
		picker.includeData = includeData
		self.viewController.present(picker, animated: true, completion: nil)
	}

	func detectMimeType (_ url: URL) -> String {
		if let uti = UTTypeCreatePreferredIdentifierForTag(
			kUTTagClassFilenameExtension,
			url.pathExtension as CFString,
			nil
		)?.takeRetainedValue() {
			if let mimetype = UTTypeCopyPreferredTagWithClass(
				uti,
				kUTTagClassMIMEType
			)?.takeRetainedValue() as String? {
				return mimetype
			}
		}

		return "application/octet-stream"
	}

	func documentWasSelected (includeData: Bool, url: URL) {
		var error: NSError?

		NSFileCoordinator().coordinate(
			readingItemAt: url,
			options: [],
			error: &error
		) { newURL in
			let maybeData = try? Data(contentsOf: newURL, options: [])

			guard let data = maybeData else {
				self.sendError("Failed to fetch data.")
				return
			}

			do {
				let result = [
					"data": includeData ? data.base64EncodedString() : "",
					"mediaType": self.detectMimeType(newURL),
					"name": newURL.lastPathComponent,
					"uri": newURL.absoluteString
				]

				if let message = try String(
					data: JSONSerialization.data(
						withJSONObject: result,
						options: []
					),
					encoding: String.Encoding.utf8
				) {
					self.send(message)
				}
				else {
					self.sendError("Serializing result failed.")
				}

				newURL.stopAccessingSecurityScopedResource()
			}
			catch let error {
				self.sendError(error.localizedDescription)
			}
		}

		if let error = error {
			self.sendError(error.localizedDescription)
		}

		url.stopAccessingSecurityScopedResource()
	}

	@objc(getFile:)
	func getFile (command: CDVInvokedUrlCommand) {
		self.commandCallback = command.callbackId

		let accept = command.arguments.first as! String
		let includeData = command.arguments.last as! Bool
		let mimeTypes = accept.components(separatedBy: ",")

		let utis = mimeTypes.map { (mimeType: String) -> String in
			switch mimeType {
				case "audio/*":
					return kUTTypeAudio as String
				case "font/*":
					return "public.font"
				case "image/*":
					return kUTTypeImage as String
				case "text/*":
					return kUTTypeText as String
				case "video/*":
					return kUTTypeVideo as String
				default:
					break
			}

			if mimeType.range(of: "*") == nil {
				let utiUnmanaged = UTTypeCreatePreferredIdentifierForTag(
					kUTTagClassMIMEType,
					mimeType as CFString,
					nil
				)

				if let uti = utiUnmanaged?.takeRetainedValue() as String? {
					if !uti.hasPrefix("dyn.") {
						return uti
					}
				}
			}

			return kUTTypeItem as String
		}

		self.callPicker(includeData: includeData, utis: utis)
	}

	func send (_ message: String, _ status: CDVCommandStatus = CDVCommandStatus_OK) {
		if let callbackId = self.commandCallback {
			self.commandCallback = nil

			let pluginResult = CDVPluginResult(
				status: status,
				messageAs: message
			)

			self.commandDelegate!.send(
				pluginResult,
				callbackId: callbackId
			)
		}
	}

	func sendError (_ message: String) {
		self.send(message, CDVCommandStatus_ERROR)
	}
}

extension Chooser : UIDocumentPickerDelegate {
	@available(iOS 11.0, *)
	func documentPicker (
		_ controller: UIDocumentPickerViewController,
		didPickDocumentsAt urls: [URL]
	) {
		let picker = controller as! ChooserUIDocumentPickerViewController
		if let url = urls.first {
			self.documentWasSelected(includeData: picker.includeData, url: url)
		}
	}

	func documentPicker (
		_ controller: UIDocumentPickerViewController,
		didPickDocumentAt url: URL
	) {
		let picker = controller as! ChooserUIDocumentPickerViewController
		self.documentWasSelected(includeData: picker.includeData, url: url)
	}

	func documentPickerWasCancelled (_ controller: UIDocumentPickerViewController) {
		self.send("RESULT_CANCELED")
	}
}
