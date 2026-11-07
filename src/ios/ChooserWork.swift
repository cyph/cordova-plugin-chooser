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

/** Picker processing is bounded and queued, including workers abandoned by reset. */
final class ChooserWork {
	private static let operations: OperationQueue = {
		let queue = OperationQueue()
		queue.name = "com.cyph.cordova.chooser.requests"
		queue.qualityOfService = .userInitiated
		queue.maxConcurrentOperationCount = 4
		return queue
	}()
	private let lock = NSLock()
	private var started = false
	private var released = false

	static func reserve() -> ChooserWork? { return ChooserWork() }
	private init() {}

	// Explicit GCD handoff for Swift 5 callbacks. Mutable request/file state
	// remains protected by its locks; this does not add actor inheritance.
	static func dispatch(on queue: DispatchQueue, _ action: @escaping () -> Void) {
		queue.async(execute: DispatchWorkItem(block: action))
	}

	static func enqueue(on queue: OperationQueue, _ action: @escaping () -> Void) {
		queue.addOperation(ChooserOperation(action))
	}

	func run(_ action: @escaping () -> Void) {
		lock.lock()
		guard !started, !released else { lock.unlock(); return }
		started = true
		lock.unlock()
		Self.enqueue(on: Self.operations) {
			defer { self.lock.lock(); self.released = true; self.lock.unlock() }
			action()
		}
	}
	func releaseIfIdle() {
		lock.lock(); defer { lock.unlock() }
		if !started { released = true }
	}
}

// OperationQueue owns execution exactly once. The caller supplies an immutable
// handoff whose mutable captures are confined to the operation or use locks.
private final class ChooserOperation: Operation, @unchecked Sendable {
	private let action: () -> Void
	init(_ action: @escaping () -> Void) { self.action = action; super.init() }
	override func main() { action() }
}
