@objc(FileChooser)
class FileChooser : CDVPlugin {
    var commandCallback: String?


    @objc(select:)
    func select(command: CDVInvokedUrlCommand) {
        let mimeType = command.arguments.first ?? "*/*"

        let utiUnmanaged = UTTypeCreatePreferredIdentifierForTag(
            kUTTagClassMIMEType,
            mimeType,
            nil
        )

        let uti = (utiUnmanaged?.takeRetainedValue() as String) ?? "public.data"

        commandCallback = command.callbackId
        callPicker(uti)
    }

    func callPicker(uti: String) {
        let picker = UIDocumentPickerViewController(documentTypes: [uti], in: .import)
        picker.delegate = self
        self.viewController.present(picker, animated: true, completion: nil)
    }

    func documentWasSelected(url: URL) {
        if let commandId = commandCallback  {
            commandCallback = nil

            var error: NSError?

            NSFileCoordinator().coordinateReadingItemAtURL(url, options, error: &error) { newURL in
                let request = URLRequest(
                    url: newURL,
                    cachePolicy: URLRequest.CachePolicy.useProtocolCachePolicy,
                    timeoutInterval: 0.1
                )

                URLSession.shared.dataTask(
                    with: request as URLRequest,
                    completionHandler: { data, response, error in
                        guard error == nil else {
                            sendError(error.localizedDescription)
                        }

                        guard let data = data else {
                            sendError("Failed to fetch data.")
                        }

                        guard let response = response else {
                            sendError("No response.")
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
                                messageAs: try? String(
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
                        } catch let error {
                            sendError(error.localizedDescription)
                        }
                    }
                )
            }

            guard error == nil else {
                sendError(error.localizedDescription)
            }
        }else{
            sendError("Unexpected error. Try again?")
        }

        url.stopAccessingSecurityScopedResource()
    }

    func sendError(_ message: String) {

        let pluginResult = CDVPluginResult(
            status: CDVCommandStatus_ERROR,
            messageAs: message
        )

        self.commandDelegate!.send(
            pluginResult,
            callbackId: commandCallback
        )
    }

}

extension FileChooser: UIDocumentPickerDelegate {

    @available(iOS 11.0, *)
    func fileChooser(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if let url = urls.first {
            documentWasSelected(url)
        }
    }


    func fileChooser(_ controller: UIDocumentPickerViewController, didPickDocumentAt url: URL){
        documentWasSelected(url)
    }

    func fileChooserWasCancelled(_ controller: UIDocumentPickerViewController) {
        sendError("User canceled.")
    }

}
