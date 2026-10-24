import Foundation

#if compiler(>=5.9)
typealias ChooserMainAction = @MainActor () -> Void
#else
typealias ChooserMainAction = () -> Void
#endif

/**
 Legacy reference handoff. The payload must be immutable, internally locked,
 or have main-actor-isolated mutable state. Access remains main-only; this
 adapter does not make Cordova commands, plugin objects or requests Sendable.
 */
final class ChooserMainReference<Value> {
	private let stored: Value
	init(_ value: Value) { stored = value }
	#if compiler(>=5.9)
	@MainActor
	#endif
	var value: Value {
		dispatchPrecondition(condition: .onQueue(.main))
		return stored
	}
}

#if compiler(>=5.9)
// Only the opaque handoff is transferable; its getter enforces the executor.
extension ChooserMainReference: @unchecked Sendable {}
#endif

/** Synchronous when already on main, including Cordova's reset callback. */
enum ChooserMain {
	static func run(_ action: @escaping ChooserMainAction) {
		if Thread.isMainThread { invoke(action) }
		else { ChooserWork.dispatch(on: .main) { invoke(action) } }
	}

	private static func invoke(_ action: ChooserMainAction) {
		dispatchPrecondition(condition: .onQueue(.main))
		#if compiler(>=5.9)
		if #available(iOS 17.0, macOS 14.0, *) {
			MainActor.assumeIsolated(action)
			return
		}
		#endif
		invokeLegacy(action)
	}

	// Back-deploy the checked synchronous actor bridge without raising the OS
	// floor. Erase only the closure annotation, after asserting its executor.
	static func invokeLegacy(_ action: ChooserMainAction) {
		dispatchPrecondition(condition: .onQueue(.main))
		#if compiler(>=5.9)
		withoutActuallyEscaping(action) { callback in
			let unisolated = unsafeBitCast(callback, to: (() -> Void).self)
			unisolated()
		}
		#else
		action()
		#endif
	}
}

/** A lease survives reset until its actual file worker returns. */
final class ChooserWork {
	private static let capacity = DispatchSemaphore(value: 2)
	private let lock = NSLock()
	private var started = false
	private var released = false
	private let queue = DispatchQueue(label: "com.cyph.cordova.chooser.request." + UUID().uuidString, qos: .userInitiated)

	static func reserve() -> ChooserWork? {
		guard capacity.wait(timeout: .now()) == .success else { return nil }
		return ChooserWork()
	}
	private init() {}

	// Explicit GCD handoff for Swift 5 callbacks. Request/worker locks protect
	// shared state; each request's file operations remain sequential.
	static func dispatch(on queue: DispatchQueue, _ action: @escaping () -> Void) {
		queue.async(execute: DispatchWorkItem(block: action))
	}

	func run(_ action: @escaping () -> Void) {
		lock.lock()
		guard !started, !released else { lock.unlock(); return }
		started = true
		lock.unlock()
		Self.dispatch(on: queue) {
			defer { self.release() }
			action()
		}
	}
	func releaseIfIdle() {
		lock.lock()
		if !started, !released { released = true; Self.capacity.signal() }
		lock.unlock()
	}
	private func release() {
		lock.lock()
		if !released { released = true; Self.capacity.signal() }
		lock.unlock()
	}
	deinit { releaseIfIdle() }
}
