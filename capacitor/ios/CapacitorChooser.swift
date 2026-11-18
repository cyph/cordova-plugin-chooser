import Capacitor
import Foundation
import WebKit

@objc(CapacitorChooser)
public final class CapacitorChooser: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "CapacitorChooser"
	public let jsName = "Chooser"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "cancelPick", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "cancelRead", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "statFile", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "releaseFile", returnType: CAPPluginReturnPromise)
	]

	private lazy var engine = ChooserEngine { [weak self] in self?.bridge?.viewController }
	private var navigation: NSKeyValueObservation?

	public override func load() {
		let engine = engine
		navigation = webView?.observe(\.isLoading, options: [.new]) { [weak engine] _, change in
			if change.newValue == true { engine?.onReset() }
		}
	}

	deinit { engine.onReset() }

	private func command(_ call: CAPPluginCall) -> ChooserCommand {
		ChooserCommand(arguments: call.options["args"] as? [Any] ?? [], callbackId: call.callbackId) { [weak self] value, failed in
			guard self?.bridge != nil else { return false }
			if failed, let detail = value as? [String: Any] {
				call.reject(detail["message"] as? String ?? "Chooser operation failed.", detail["code"] as? String, nil, detail)
			} else {
				call.resolve(["value": value])
			}
			return true
		}
	}

	@objc public func pick(_ call: CAPPluginCall) { engine.pick(command: command(call)) }
	@objc public func cancelPick(_ call: CAPPluginCall) { engine.cancelPick(command: command(call)) }
	@objc public func readFile(_ call: CAPPluginCall) { engine.readFile(command: command(call)) }
	@objc public func cancelRead(_ call: CAPPluginCall) { engine.cancelRead(command: command(call)) }
	@objc public func statFile(_ call: CAPPluginCall) { engine.statFile(command: command(call)) }
	@objc public func releaseFile(_ call: CAPPluginCall) { engine.releaseFile(command: command(call)) }
}
