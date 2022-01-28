import UIKit
import MobileCoreServices
import Foundation
import Cordova

@objc(Chooser)
class Chooser : CDVPlugin {
	var commandCallback: String?
    
    struct FileInfo: Codable {
        let mediaType: String
        let name: String
        let uri: String
     }

	func callPicker (utis: [String]) {
		let picker = UIDocumentPickerViewController(documentTypes: utis, in: .import)
		picker.delegate = self
        if #available(iOS 11.0, *) {
            picker.allowsMultipleSelection = true
        }

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
			)?.takeRetainedValue() as? String {
				return mimetype
			}
		}

		return "application/octet-stream"
	}

	func documentWasSelected (urls: [URL]) {
		var error: NSError?
        let coordinator = NSFileCoordinator();
        var results: [FileInfo] = [];
        for url in urls {
            coordinator.coordinate(
                readingItemAt: url,
                options: [],
                error: &error
            ) { newURL in
                let result = FileInfo(
                    mediaType: self.detectMimeType(newURL),
                    name: newURL.lastPathComponent,
                    uri: newURL.absoluteString
                )

                results.append(result);
                
                newURL.stopAccessingSecurityScopedResource()
            }
        }
        do {
            let jsonData = try JSONEncoder().encode(results)
            let jsonString = String(data: jsonData, encoding: .utf8)!
            self.send(jsonString)
        }
        catch {
            self.sendError("Serializing result failed.")
        }
        
		if let error = error {
			self.sendError(error.localizedDescription)
		}
    }

	@objc(getFiles:)
	func getFiles(command: CDVInvokedUrlCommand) {
		self.commandCallback = command.callbackId

		let accept = command.arguments.first as! String
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

				if let uti = (utiUnmanaged?.takeRetainedValue() as? String) {
					if !uti.hasPrefix("dyn.") {
						return uti
					}
				}
			}

			return kUTTypeData as String
		}

		self.callPicker(utis: utis)
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
        self.documentWasSelected(urls: urls)
	}

	func documentPicker (
		_ controller: UIDocumentPickerViewController,
		didPickDocumentAt url: URL
	) {
		self.documentWasSelected(urls: [url])
	}

	func documentPickerWasCancelled (_ controller: UIDocumentPickerViewController) {
		self.sendError("RESULT_CANCELED")
	}
}
