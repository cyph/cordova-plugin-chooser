package com.cyph.cordova;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class ChooserResourcesTest {
	@Rule public TemporaryFolder temporary = new TemporaryFolder();

	private static class Source implements ChooserResources.SourceAccess {
		final InputStream input;
		final AtomicInteger opens = new AtomicInteger();
		final AtomicInteger cancels = new AtomicInteger();
		Source(InputStream input) { this.input = input; }
		public InputStream open() { opens.incrementAndGet(); return input; }
		public void cancel() { cancels.incrementAndGet(); }
	}
	private static ChooserResources.Batch batch(long perFile, long total) {
		return new ChooserResources.Batch(new ChooserBudget(perFile, total));
	}

	@Test public void managedRangesArePositionalAndRestoreUsesActualCacheSize() throws Exception {
		File cache = temporary.newFolder();
		File file = ChooserFiles.create(cache);
		byte[] bytes = new byte[600003];
		for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
		Files.write(file.toPath(), bytes);
		ChooserResources resources = new ChooserResources(cache);
		assertEquals(bytes.length, resources.stat(file.getName()).size);
		assertArrayEquals(Arrays.copyOfRange(bytes, 500000, 500100), resources.read(file.getName(), 500000, 100).data);
		assertArrayEquals(Arrays.copyOfRange(bytes, 3, 18), resources.read(file.getName(), 3, 15).data);
		assertTrue(resources.read(file.getName(), bytes.length - 2, 8).eof);
		assertTrue(resources.read(file.getName(), bytes.length + 10, 8).eof);
		assertEquals(0, resources.read(file.getName(), 0, 0).data.length);
		assertFalse(resources.read(file.getName(), 0, 0).eof);
		assertThrows(ChooserError.class, () -> resources.read(file.getName(), 0, ChooserResources.MAX_CHUNK + 1));
		assertThrows(ChooserError.class, () -> resources.read(file.getName(), ChooserFiles.MAX_SAFE_INTEGER, 1));
		resources.release(file.getName());
		resources.release(file.getName());
		assertFalse(file.exists());
		assertEquals(ChooserError.Code.FILE_RELEASED, assertThrows(ChooserError.class, () -> resources.read(file.getName(), 0, 1)).code);
	}

	@Test public void statAndReleaseRefuseForeignPathsSymlinksAndDirectories() throws Exception {
		File cache = temporary.newFolder();
		ChooserResources resources = new ChooserResources(cache);
		File foreign = temporary.newFile();
		Files.write(foreign.toPath(), new byte[]{42});
		File owned = ChooserFiles.create(cache);
		Files.delete(owned.toPath());
		assertEquals(ChooserError.Code.FILE_UNAVAILABLE, assertThrows(ChooserError.class, () -> resources.stat(owned.getName())).code);
		Files.createSymbolicLink(owned.toPath(), foreign.toPath());
		assertThrows(ChooserError.class, () -> resources.stat(owned.getName()));
		assertThrows(ChooserError.class, () -> resources.release(owned.getName()));
		assertArrayEquals(new byte[]{42}, Files.readAllBytes(foreign.toPath()));
		Files.delete(owned.toPath());
		assertTrue(owned.mkdir());
		assertThrows(ChooserError.class, () -> new ChooserResources(cache).stat(owned.getName()));
		assertThrows(ChooserError.class, () -> resources.release("../" + foreign.getName()));
		assertTrue(owned.delete());
		resources.release(owned.getName()); // Failed release remains retryable.
	}

	@Test public void sourcesOpenLazilyReadSequentiallyAndCloseOnRelease() throws Exception {
		ChooserResources resources = new ChooserResources(temporary.newFolder());
		AtomicInteger closed = new AtomicInteger();
		Source source = new Source(new ByteArrayInputStream(new byte[]{1, 2, 3, 4, 5}) {
			@Override public void close() { closed.incrementAndGet(); }
		});
		String id = resources.register(source, batch(5, 5));
		assertEquals(0, source.opens.get());
		assertEquals(0, resources.read(id, 0, 0).data.length);
		assertEquals(0, source.opens.get());
		assertArrayEquals(new byte[]{1, 2}, resources.read(id, 0, 2).data);
		assertEquals(1, source.opens.get());
		assertEquals(ChooserError.Code.INVALID_ARGUMENT, assertThrows(ChooserError.class, () -> resources.read(id, 0, 1)).code);
		assertArrayEquals(new byte[]{3}, resources.read(id, 2, 1).data);
		assertThrows(ChooserError.class, () -> resources.stat(id));
		resources.release(id);
		resources.release(id);
		assertEquals(1, closed.get());
		assertEquals(1, source.cancels.get());
		assertEquals(ChooserError.Code.FILE_RELEASED, assertThrows(ChooserError.class, () -> resources.read(id, 3, 1)).code);
		Source unopened = new Source(new ByteArrayInputStream(new byte[]{9}));
		String unopenedId = resources.register(unopened, batch(0, 0));
		resources.release(unopenedId);
		assertEquals(0, unopened.opens.get());
	}

	@Test public void partialAndZeroReadsAreCountedAgainstSharedActualByteBudgets() throws Exception {
		ChooserResources resources = new ChooserResources(temporary.newFolder());
		ChooserResources.Batch batch = batch(3, 4);
		Source first = new Source(new ByteArrayInputStream(new byte[]{1, 2, 3}) {
			@Override public synchronized int read(byte[] b, int off, int len) { return 0; }
		});
		String id = resources.register(first, batch);
		ChooserResources.Chunk chunk = resources.read(id, 0, 8);
		assertArrayEquals(new byte[]{1, 2, 3}, chunk.data);
		assertTrue(chunk.eof);
		assertEquals(0, resources.read(id, 3, 8).data.length);
		String second = resources.register(new Source(new ByteArrayInputStream(new byte[]{4, 5})), batch);
		assertArrayEquals(new byte[]{4}, resources.read(second, 0, 1).data);
		assertEquals(ChooserError.Code.TOTAL_SIZE_EXCEEDED, assertThrows(ChooserError.class, () -> resources.read(second, 1, 1)).code);
		assertEquals(ChooserError.Code.TOTAL_SIZE_EXCEEDED, assertThrows(ChooserError.class, () -> resources.read(id, 3, 1)).code);
		resources.release(id);
		resources.release(second);
		String excessive = resources.register(new Source(new ByteArrayInputStream(new byte[]{1, 2, 3})), batch(2, 0));
		assertEquals(ChooserError.Code.FILE_TOO_LARGE, assertThrows(ChooserError.class, () -> resources.read(excessive, 0, 8)).code);
		resources.release(excessive);
		String empty = resources.register(new Source(new ByteArrayInputStream(new byte[0])), batch(1, 1));
		assertTrue(resources.read(empty, 0, 8).eof);
		resources.release(empty);
	}

	@Test public void releaseWaitsForActualReaderAndRefusesNewLeases() throws Exception {
		ChooserResources resources = new ChooserResources(temporary.newFolder());
		CountDownLatch started = new CountDownLatch(1);
		CountDownLatch resume = new CountDownLatch(1);
		CountDownLatch cancelled = new CountDownLatch(1);
		AtomicInteger closed = new AtomicInteger();
		Source source = new Source(new ByteArrayInputStream(new byte[]{7}) {
			@Override public synchronized int read(byte[] bytes, int off, int length) {
				started.countDown();
				try { assertTrue(resume.await(5, TimeUnit.SECONDS)); }
				catch (InterruptedException error) { throw new AssertionError(error); }
				return super.read(bytes, off, length);
			}
			@Override public void close() { closed.incrementAndGet(); }
		}) { @Override public void cancel() { super.cancel(); cancelled.countDown(); } };
		String id = resources.register(source, batch(0, 0));
		ExecutorService workers = Executors.newFixedThreadPool(2);
		try {
			Future<ChooserResources.Chunk> reading = workers.submit(() -> resources.read(id, 0, 1));
			assertTrue(started.await(5, TimeUnit.SECONDS));
			Future<?> releasing = workers.submit(() -> { resources.release(id); return null; });
			assertTrue(cancelled.await(5, TimeUnit.SECONDS));
			assertFalse(releasing.isDone());
			// Source interruption may close early, but release still waits for the native call to leave.
			assertEquals(1, closed.get());
			assertEquals(ChooserError.Code.FILE_RELEASED, assertThrows(ChooserError.class, () -> resources.read(id, 1, 1)).code);
			resume.countDown();
			ExecutionException cancelledRead = assertThrows(ExecutionException.class, () -> reading.get(5, TimeUnit.SECONDS));
			assertEquals(ChooserError.Code.CANCELLED, ((ChooserError) cancelledRead.getCause()).code);
			releasing.get(5, TimeUnit.SECONDS);
			assertEquals(1, closed.get());
		}
		finally { resume.countDown(); workers.shutdownNow(); }
	}

	@Test public void failedSourceCloseCanBeRetriedWithoutReopening() throws Exception {
		ChooserResources resources = new ChooserResources(temporary.newFolder());
		AtomicInteger attempts = new AtomicInteger();
		Source source = new Source(new ByteArrayInputStream(new byte[]{1, 2}) {
			@Override public void close() throws IOException { if (attempts.incrementAndGet() == 1) throw new IOException("close failed"); }
		});
		String id = resources.register(source, batch(0, 0));
		resources.read(id, 0, 1);
		assertThrows(IOException.class, () -> resources.release(id));
		assertEquals(ChooserError.Code.FILE_RELEASED, assertThrows(ChooserError.class, () -> resources.read(id, 1, 1)).code);
		resources.release(id);
		assertEquals(2, attempts.get());
		assertEquals(1, source.opens.get());
	}
	@Test public void cancelReadClosesBlockedSourceWithoutDeletingProviderOrManagedFiles() throws Exception {
		File cache = temporary.newFolder();
		ChooserResources resources = new ChooserResources(cache);
		File managed = ChooserFiles.create(cache);
		Files.write(managed.toPath(), new byte[]{8});
		CountDownLatch started = new CountDownLatch(1);
		CountDownLatch closed = new CountDownLatch(1);
		AtomicInteger closes = new AtomicInteger();
		Source source = new Source(new InputStream() {
			@Override public int read() throws IOException {
				started.countDown();
				try { if (!closed.await(5, TimeUnit.SECONDS)) throw new IOException("read timed out"); }
				catch (InterruptedException error) { throw new IOException(error); }
				throw new IOException("stream closed");
			}
			@Override public void close() { closes.incrementAndGet(); closed.countDown(); }
		});
		String id = resources.register(source, batch(0, 0));
		ExecutorService worker = Executors.newSingleThreadExecutor();
		try {
			Future<?> read = worker.submit(() -> resources.read(id, 0, 1));
			assertTrue(started.await(5, TimeUnit.SECONDS));
			resources.cancelRead(id);
			ExecutionException failure = assertThrows(ExecutionException.class, () -> read.get(5, TimeUnit.SECONDS));
			assertEquals(ChooserError.Code.CANCELLED, ((ChooserError) failure.getCause()).code);
			assertThrows(ChooserError.class, () -> resources.cancelRead(managed.getName()));
			assertArrayEquals(new byte[]{8}, resources.read(managed.getName(), 0, 1).data);
			resources.release(id);
			assertEquals(1, closes.get());
		}
		finally { closed.countDown(); worker.shutdownNow(); }
	}

	@Test public void cancelDuringOpenClosesLateProviderStreamAndReleasedEntryDropsClosure() throws Exception {
		ChooserResources resources = new ChooserResources(temporary.newFolder());
		CountDownLatch started = new CountDownLatch(1);
		CountDownLatch resume = new CountDownLatch(1);
		AtomicInteger closes = new AtomicInteger();
		Source source = new Source(new ByteArrayInputStream(new byte[]{1}) {
			@Override public void close() { closes.incrementAndGet(); }
		}) {
			@Override public InputStream open() {
				started.countDown();
				try { assertTrue(resume.await(5, TimeUnit.SECONDS)); }
				catch (InterruptedException error) { throw new AssertionError(error); }
				return super.open();
			}
		};
		String id = resources.register(source, batch(0, 0));
		ExecutorService worker = Executors.newSingleThreadExecutor();
		try {
			Future<?> read = worker.submit(() -> resources.read(id, 0, 1));
			assertTrue(started.await(5, TimeUnit.SECONDS));
			resources.cancelRead(id);
			resume.countDown();
			ExecutionException failure = assertThrows(ExecutionException.class, () -> read.get(5, TimeUnit.SECONDS));
			assertEquals(ChooserError.Code.CANCELLED, ((ChooserError) failure.getCause()).code);
			resources.release(id);
			assertEquals(1, closes.get());
			assertTrue(resources.sources().isEmpty());
			// Cancellation remains idempotent after release without retaining a provider callback.
			int cancellations = source.cancels.get();
			resources.cancelRead(id);
			assertEquals(cancellations, source.cancels.get());
		}
		finally { resume.countDown(); worker.shutdownNow(); }
	}

}
