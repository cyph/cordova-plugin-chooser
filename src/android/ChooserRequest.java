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
	final String requestId;
	final String source;
	final String[] mediaTypes;
	final java.util.List<String> sources = new java.util.ArrayList<>();
	final String accept;
	final Mode mode;
	final boolean multiple;
	final boolean localOnly;
	final long limit;
	final long maxFiles;
	final long maxTotalSize;
	final ChooserBudget budget;
	final int code;
	final CancellationSignal cancellation = new CancellationSignal();
	volatile boolean canceled;
	boolean restoredAbandoned;
	private State state = State.SELECTING;
	private ChooserTransaction transaction;
	private java.io.InputStream input;

	ChooserRequest(CallbackContext callback, String accept, Mode mode, boolean multiple, boolean localOnly, long limit, int code) {
		this(callback, accept, mode, multiple, localOnly, limit, 0, 0, code);
	}
	ChooserRequest(CallbackContext callback, String accept, Mode mode, boolean multiple, boolean localOnly, long limit, long maxFiles, long maxTotalSize, int code) {
		this(callback, accept, mode, multiple, localOnly, limit, maxFiles, maxTotalSize, code,
			java.util.UUID.randomUUID().toString(), "documents", new String[]{"image", "video"});
	}
	ChooserRequest(CallbackContext callback, String accept, Mode mode, boolean multiple, boolean localOnly, long limit, long maxFiles, long maxTotalSize, int code, String requestId, String source, String[] mediaTypes) {
		this.callback = callback;
		this.requestId = requestId;
		this.source = source;
		this.mediaTypes = mediaTypes.clone();
		this.accept = accept;
		this.mode = mode;
		this.multiple = multiple;
		this.localOnly = localOnly;
		this.limit = limit;
		this.maxFiles = maxFiles;
		this.maxTotalSize = maxTotalSize;
		this.budget = new ChooserBudget(limit, maxTotalSize);
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
	synchronized boolean completeCanceled() {
		if (!canceled || state == State.COMPLETING || state == State.FINISHED) return false;
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
	void attachInput(java.io.InputStream value) throws java.io.IOException {
		boolean stop;
		synchronized (this) { input = value; stop = canceled; }
		if (stop) { value.close(); checkCanceled(); }
	}
	synchronized void detachInput(java.io.InputStream value) { if (input == value) input = null; }
	void cancel() {
		java.io.InputStream opened;
		synchronized (this) { canceled = true; opened = input; }
		// Closing an opened stream interrupts pipe reads; CancellationSignal also covers open/query.
		// Both happen outside plugin/request monitors.
		try { if (opened != null) opened.close(); } catch (java.io.IOException ignored) {}
		cancellation.cancel();
	}
	void checkCanceled() throws ChooserError {
		if (canceled) throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Request was reset.");
	}
}
