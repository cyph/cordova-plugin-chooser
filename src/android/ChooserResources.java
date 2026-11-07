package com.cyph.cordova;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.FilterInputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;

/** Owns cache leases and transient provider streams. No provider I/O runs under the registry monitor. */
final class ChooserResources {
	static final int MAX_CHUNK = 262144;
	interface SourceAccess {
		InputStream open() throws IOException;
		void cancel();
	}
	static final class Chunk {
		final byte[] data;
		final boolean eof;
		Chunk(byte[] data, boolean eof) { this.data = data; this.eof = eof; }
	}
	static final class Batch {
		private final ChooserBudget budget;
		private ChooserError failure;
		Batch(ChooserBudget budget) { this.budget = budget; }
		synchronized void check() throws ChooserError { if (failure != null) throw failure; }
		synchronized void consume(long position, int count) throws ChooserError {
			check();
			try { budget.consume(position, count); }
			catch (ChooserError error) { failure = error; throw error; }
		}
	}
	private static final class SourceStream extends FilterInputStream {
		private boolean closed;
		SourceStream(InputStream input) { super(input); }
		@Override public synchronized void close() throws IOException {
			if (!closed) { in.close(); closed = true; }
		}
	}
	private static final class Entry {
		final String id;
		SourceAccess source;
		Batch batch;
		boolean transientSource;
		final Object readLock = new Object();
		final Object releaseLock = new Object();
		SourceStream input;
		volatile boolean interrupted;
		long position;
		boolean eof;
		boolean failed;
		boolean releasing;
		boolean released;
		int leases;
		Entry(String id, SourceAccess source, Batch batch) {
			this.id = id; this.source = source; this.batch = batch; this.transientSource = source != null;
		}
		synchronized void acquire() throws ChooserError {
			if (releasing || released) throw new ChooserError(ChooserError.Code.FILE_RELEASED, "File has been released.");
			leases++;
		}
		synchronized void done() { leases--; notifyAll(); }
		synchronized void markReleasing() { releasing = true; }
	}
	private final File cache;
	private final Map<String, Entry> entries = new HashMap<>();
	private final Map<String, Boolean> released = new HashMap<>();
	private final Semaphore readers = new Semaphore(4, true);

	ChooserResources(File cache) { this.cache = cache; }

	synchronized String register(SourceAccess source, Batch batch) throws IOException {
		String id;
		do { id = UUID.randomUUID().toString(); }
		while (entries.containsKey(id) || released.containsKey(id) || ChooserFiles.entryExists(new File(ChooserFiles.directory(cache), id)));
		entries.put(id, new Entry(id, source, batch));
		return id;
	}

	private synchronized Entry entry(String id) throws ChooserError {
		if (!ChooserFiles.isId(id)) throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Expected a managed file id.");
		Entry value = entries.get(id);
		if (value == null) {
			value = new Entry(id, null, null);
			Boolean wasSource = released.get(id);
			if (wasSource != null) {
				value.released = true;
				value.releasing = true;
				value.transientSource = wasSource;
			}
			else entries.put(id, value);
		}
		return value;
	}

	/** Mark synchronously at bridge dispatch, before a release worker can be delayed. */
	void beginRelease(String id) throws ChooserError { entry(id).markReleasing(); }

	static final class Stat {
		final File file;
		final long size;
		Stat(File file) { this.file = file; this.size = file.length(); }
	}

	Stat stat(String id) throws IOException {
		Entry value = entry(id);
		value.acquire();
		try {
			if (value.transientSource) throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Transient sources cannot be restored.");
			return new Stat(ChooserFiles.managed(cache, id));
		}
		finally { value.done(); }
	}

	Chunk read(String id, long offset, int length) throws IOException {
		if (offset < 0 || offset > ChooserFiles.MAX_SAFE_INTEGER || length < 0 || length > MAX_CHUNK || offset > ChooserFiles.MAX_SAFE_INTEGER - length) {
			throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Invalid chunk range.");
		}
		Entry value = entry(id);
		try { readers.acquire(); }
		catch (InterruptedException error) {
			Thread.currentThread().interrupt();
			throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Read was interrupted.");
		}
		boolean leased = false;
		try {
			value.acquire();
			leased = true;
			if (!value.transientSource) return readManaged(value.id, offset, length);
			synchronized (value.readLock) { return readSource(value, offset, length); }
		}
		finally { if (leased) value.done(); readers.release(); }
	}

	private Chunk readManaged(String id, long offset, int length) throws IOException {
		File file = ChooserFiles.managed(cache, id);
		try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
			long size = input.length();
			int count = (int) Math.min(length, Math.max(0, size - offset));
			byte[] bytes = new byte[count];
			input.seek(offset);
			int total = 0;
			while (total < count) {
				int read = input.read(bytes, total, count - total);
				if (read < 0) break;
				total += read;
			}
			return new Chunk(trim(bytes, total), offset >= size || total < count || offset + total >= size);
		}
	}

	private static void checkInterrupted(Entry value) throws ChooserError {
		if (value.interrupted) throw new ChooserError(ChooserError.Code.CANCELLED, "Source read was cancelled.");
	}

	private Chunk readSource(Entry value, long offset, int length) throws IOException {
		checkInterrupted(value);
		value.batch.check();
		if (value.failed) throw new ChooserError(ChooserError.Code.READ_FAILED, "Source reader previously failed.");
		if (offset != value.position) throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Source reads must be sequential.");
		if (length == 0 || value.eof) return new Chunk(new byte[0], value.eof);
		SourceStream input;
		synchronized (value) { input = value.input; }
		try {
			if (input == null) {
				InputStream opened = value.source.open();
				if (opened == null) throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned no stream.");
				input = new SourceStream(opened);
				synchronized (value) { value.input = input; }
				// cancelRead may finish while a provider ignores CancellationSignal during open.
				if (value.interrupted) { input.close(); checkInterrupted(value); }
			}
			byte[] bytes = new byte[length];
			int total = 0;
			while (total < length) {
				checkInterrupted(value);
				int count = input.read(bytes, total, length - total);
				checkInterrupted(value);
				if (count < 0) { value.eof = true; break; }
				if (count == 0) {
					int next = input.read();
					checkInterrupted(value);
					if (next < 0) { value.eof = true; break; }
					bytes[total] = (byte) next;
					count = 1;
				}
				value.batch.consume(value.position, count);
				value.position += count;
				total += count;
			}
			if (value.eof) { input.close(); synchronized (value) { value.input = null; } }
			return new Chunk(trim(bytes, total), value.eof);
		}
		catch (IOException | RuntimeException error) {
			value.failed = true;
			if (value.interrupted) throw new ChooserError(ChooserError.Code.CANCELLED, "Source read was cancelled.");
			throw error;
		}
	}

	void beginCancelRead(String id) throws ChooserError {
		Entry value = entry(id);
		synchronized (value) {
			if (!value.transientSource) throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Only transient sources can be cancelled.");
			value.interrupted = true;
		}
	}

	/** Closing a provider stream can interrupt read(); it never removes a managed file. */
	void cancelRead(String id) throws IOException {
		Entry value = entry(id);
		beginCancelRead(id);
		SourceAccess source;
		SourceStream input;
		synchronized (value) { source = value.source; input = value.input; }
		// Close first: a provider cancellation listener may wait for its outstanding read.
		IOException closeFailure = null;
		if (input != null) try { input.close(); } catch (IOException error) { closeFailure = error; }
		if (source != null) {
			try { source.cancel(); } catch (RuntimeException ignored) {}
		}
		if (closeFailure != null) throw closeFailure;
	}

	private static byte[] trim(byte[] bytes, int length) {
		return bytes.length == length ? bytes : java.util.Arrays.copyOf(bytes, length);
	}

	void release(String id) throws IOException {
		Entry value = entry(id);
		value.markReleasing();
		synchronized (value.releaseLock) {
			synchronized (value) { if (value.released) return; }
			// Cancellation may call an untrusted provider; do it outside registry/lease monitors.
			if (value.transientSource) cancelRead(id);
			synchronized (value) {
				while (value.leases != 0) {
					try { value.wait(); }
					catch (InterruptedException error) {
						Thread.currentThread().interrupt();
						throw new ChooserError(ChooserError.Code.RELEASE_FAILED, "Release was interrupted; retry release.");
					}
				}
			}
			if (!value.transientSource) ChooserFiles.release(cache, id);
			else if (value.input != null) value.input.close();
			synchronized (value) {
				value.released = true;
				// Keep only ID/lifecycle state, not resolver closures or provider resources.
				value.source = null;
				value.input = null;
				value.batch = null;
			}
			synchronized (this) {
				entries.remove(id);
				released.put(id, value.transientSource);
			}
		}
	}

	synchronized List<String> sources() {
		List<String> result = new ArrayList<>();
		for (Entry value : entries.values()) synchronized (value) {
			if (value.transientSource && !value.released) {
				value.markReleasing();
				result.add(value.id);
			}
		}
		return result;
	}
}
