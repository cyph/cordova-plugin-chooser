
enum DocumentTypes: String {
    case pdf = "application/pdf"
    case image = "image/*"
    case all = ""

    var uti: String {
        switch self {
            case .pdf: return "com.adobe.pdf"
            case .image: return "public.image"
            case .all: return "public.data"
        }
    }
}

@objc(FileChooser)
class FileChooser : CDVPlugin {
    var commandCallback: String?


    @objc(select:)
    func select(command: CDVInvokedUrlCommand) {

        var arguments: [DocumentTypes] = []

        command.arguments.forEach({
            if let key =  $0 as? String, let type = DocumentTypes(rawValue: key) {
                arguments.append(type)
            }else if let array = $0 as? [String] {
                array.forEach({
                    if let type = DocumentTypes(rawValue: $0) {
                        arguments.append(type)
                    }
                })
            }

        })

        if arguments.count < 1 {
            arguments.append(DocumentTypes.all)
        }

        commandCallback = command.callbackId
        callPicker(withTypes: arguments)
    }

    func callPicker(withTypes documentTypes: [DocumentTypes]) {

        let utis = documentTypes.flatMap({return $0.uti })

        let picker = UIDocumentPickerViewController(documentTypes: utis, in: .import)
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
