package com.cyph.cordova;

import android.os.CancellationSignal;
import org.apache.cordova.CallbackContext;

final class ChooserRequest {
	enum Mode {
		DATA("data"), METADATA("metadata"), COPY("copy");
		final String wire;
		Mode(String wire) { this.wire = wire; }
		static Mode parse(String wire) {
			for (Mode mode : values()) if (mode.wire.equals(wire)) return mode;
			throw new IllegalArgumentException("Unknown read mode.");
		}
	}
	enum State { SELECTING, PROCESSING, COMPLETING, FINISHED }
	final CallbackContext callback;
	final String accept;
	final Mode mode;
	final boolean multiple;
	final boolean localOnly;
	final long limit;
	final int code;
	final CancellationSignal cancellation = new CancellationSignal();
	volatile boolean canceled;
	private State state = State.SELECTING;
	private ChooserTransaction transaction;

	ChooserRequest(CallbackContext callback, String accept, Mode mode, boolean multiple, boolean localOnly, long limit, int code) {
		this.callback = callback;
		this.accept = accept;
		this.mode = mode;
		this.multiple = multiple;
		this.localOnly = localOnly;
		this.limit = limit;
		this.code = code;
	}
	synchronized State state() { return state; }
	synchronized boolean process() {
		if (state != State.SELECTING || canceled) return false;
		state = State.PROCESSING;
		return true;
	}
	synchronized boolean complete() {
		if (canceled || (state != State.SELECTING && state != State.PROCESSING)) return false;
		state = State.COMPLETING;
		return true;
	}
	synchronized void finish() { state = State.FINISHED; }
	synchronized void attach(ChooserTransaction value) { transaction = value; }
	synchronized ChooserTransaction transaction() { return transaction; }
	void finishResources(boolean delivered) {
		final ChooserTransaction value;
		synchronized (this) { value = transaction; transaction = null; }
		if (value != null) ChooserTransaction.HOUSEKEEPING.execute(() -> value.finish(delivered));
	}
	void cancel() {
		synchronized (this) { canceled = true; state = State.FINISHED; }
		// Never call provider cancellation while holding a plugin/request monitor.
		cancellation.cancel();
	}
	void checkCanceled() throws ChooserError {
		if (canceled) throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Request was reset.");
	}
}
