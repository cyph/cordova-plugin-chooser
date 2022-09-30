import UIKit
import MobileCoreServices
import Foundation


class ChooserUIDocumentPickerViewController : UIDocumentPickerViewController {
	var maxFileSize: Int = 0
}

@objc(Chooser)
class Chooser : CDVPlugin {
	var commandCallback: String?

	func callPicker (maxFileSize: Int, utis: [String]) {
		let picker = ChooserUIDocumentPickerViewController(documentTypes: utis, in: .import)
		picker.delegate = self
		picker.maxFileSize = maxFileSize
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

	func documentWasSelected (maxFileSize: Int, url: URL) {
		var error: NSError?
        var fileSize: Int = 0;

        do {
            let resources = try url.resourceValues(forKeys:[.fileSizeKey])
            let fileSize = resources.fileSize!
            print ("\(fileSize)")
            if(fileSize > maxFileSize){
                self.sendError("Invalid size")
                return
            }
        } catch {
            self.sendError("Error: \(error)")
        }

		NSFileCoordinator().coordinate(
			readingItemAt: url,
			options: [],
			error: &error
		) { newURL in
			do {

				let result = [
					"path": newURL.absoluteString,
					"name": newURL.lastPathComponent,
					"mimeType": self.detectMimeType(newURL),
                    "extension": newURL.pathExtension,
                    "size": fileSize,
				] as [AnyHashable : Any]

                if let callbackId = self.commandCallback {
                    self.commandCallback = nil

                    let pluginResult = CDVPluginResult(
                        status: CDVCommandStatus_OK,
                        messageAs: result
                    )

                    self.commandDelegate!.send(
                        pluginResult,
                        callbackId: callbackId
                    )
                }

				newURL.stopAccessingSecurityScopedResource()
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

        let options = (command.arguments[0] as! [String : AnyObject])
        let mimeTypes = options["mimeTypes"] as! String
        let maxFileSize = options["maxFileSize"] as! Int


		let utis = mimeTypes.components(separatedBy: ",").map { (mimeType: String) -> String in
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

		self.callPicker(maxFileSize: maxFileSize, utis: utis)
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
			self.documentWasSelected(maxFileSize: picker.maxFileSize, url: url)
		}
	}

	func documentPicker (
		_ controller: UIDocumentPickerViewController,
		didPickDocumentAt url: URL
	) {
		let picker = controller as! ChooserUIDocumentPickerViewController
		self.documentWasSelected(maxFileSize: picker.maxFileSize, url: url)
	}

	func documentPickerWasCancelled (_ controller: UIDocumentPickerViewController) {
		self.send("RESULT_CANCELED")
	}
}
