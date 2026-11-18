import Foundation
#if canImport(Cordova)
import Cordova
#endif

@objc(Chooser)
class Chooser: CDVPlugin {
	lazy var engine = ChooserEngine { [weak self] in self?.viewController }

	private func bridge(_ command: CDVInvokedUrlCommand) -> ChooserCommand {
		let callbackId = command.callbackId ?? ""
		return ChooserCommand(arguments: command.arguments ?? [], callbackId: callbackId) { [weak self] value, failed in
			guard let delegate = self?.commandDelegate else { return false }
			let result: CDVPluginResult?
			if let message = value as? String {
				result = CDVPluginResult(status: .ok, messageAs: message)
			} else {
				result = CDVPluginResult(status: failed ? .error : .ok, messageAs: value as? [String: Any] ?? [:])
			}
			delegate.send(result, callbackId: callbackId)
			return true
		}
	}

	@objc(pick:) func pick(command: CDVInvokedUrlCommand) { engine.pick(command: bridge(command)) }
	@objc(cancelPick:) func cancelPick(command: CDVInvokedUrlCommand) { engine.cancelPick(command: bridge(command)) }
	@objc(readFile:) func readFile(command: CDVInvokedUrlCommand) { engine.readFile(command: bridge(command)) }
	@objc(cancelRead:) func cancelRead(command: CDVInvokedUrlCommand) { engine.cancelRead(command: bridge(command)) }
	@objc(statFile:) func statFile(command: CDVInvokedUrlCommand) { engine.statFile(command: bridge(command)) }
	@objc(releaseFile:) func releaseFile(command: CDVInvokedUrlCommand) { engine.releaseFile(command: bridge(command)) }

	override func onReset() { engine.onReset() }
	override func dispose() { onReset(); super.dispose() }
}
