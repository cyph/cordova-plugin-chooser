import Foundation

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
