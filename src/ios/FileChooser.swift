import UIKit
import MobileCoreServices
import Foundation


@objc(FileChooser)
class FileChooser : CDVPlugin {
	var commandCallback: String?

	func callPicker(uti: String) {
		let picker = UIDocumentPickerViewController(documentTypes: [uti], in: .import)
		picker.delegate = self
		self.viewController.present(picker, animated: true, completion: nil)
	}

	func documentWasSelected(url: URL) {
		if let commandId = self.commandCallback  {
			self.commandCallback = nil

			var error: NSError?

			NSFileCoordinator().coordinate(
				url,
				options: [],
				error: &error
			) { newURL in
				let request = URLRequest(url: newURL)

				URLSession.shared.dataTask(
					with: request as URLRequest,
					completionHandler: { data, response, error in
						if let error = error {
							self.sendError(error.localizedDescription)
						}

						guard let data = data else {
							self.sendError("Failed to fetch data.")
						}

						guard let response = response else {
							self.sendError("No response.")
						}

						do {
							let result = [
								"data": data.base64EncodedString(),
								"mediaType": response.mimeType ?? "application/octet-stream",
								"name": url.lastPathComponent,
								"uri": url.absoluteString
							]

							let pluginResult = CDVPluginResult(
								status: CDVCommandStatus_OK,
								messageAs: String(
									data: JSONSerialization.data(
										withJSONObject: result,
										options: []
									),
									encoding: String.Encoding.utf8
								)
							)

							self.commandDelegate!.send(
								pluginResult,
								callbackId: commandId
							)

							newURL.stopAccessingSecurityScopedResource()
						}
						catch let error {
							self.sendError(error.localizedDescription)
						}
					}
				)
			}

			if let error = error {
				self.sendError(error.localizedDescription)
			}
		}
		else {
			self.sendError("Unexpected error. Try again?")
		}

		url.stopAccessingSecurityScopedResource()
	}

	@objc(select:)
	func select(command: CDVInvokedUrlCommand) {
		let mimeType = command.arguments.first ?? "*/*"

		let utiUnmanaged = UTTypeCreatePreferredIdentifierForTag(
			kUTTagClassMIMEType,
			mimeType as! CFString,
			nil
		)

		let uti = (utiUnmanaged?.takeRetainedValue() as String) ?? "public.data"

		self.commandCallback = command.callbackId
		self.callPicker(uti)
	}

	func sendError(_ message: String) {
		let pluginResult = CDVPluginResult(
			status: CDVCommandStatus_ERROR,
			messageAs: message
		)

		self.commandDelegate!.send(
			pluginResult,
			callbackId: self.commandCallback
		)
	}
}

extension FileChooser : UIDocumentPickerDelegate {
	@available(iOS 11.0, *)
	func documentPicker (
		_ controller: UIDocumentPickerViewController,
		didPickDocumentsAt urls: [URL]
	) {
		if let url = urls.first {
			self.documentWasSelected(url: url)
		}
	}

	func documentPicker (
		_ controller: UIDocumentPickerViewController,
		didPickDocumentAt url: URL
	) {
		self.documentWasSelected(url: url)
	}

	func documentPickerWasCancelled (_ controller: UIDocumentPickerViewController) {
		self.sendError("User canceled.")
	}
}
