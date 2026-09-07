package com.cyph.cordova;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class ChooserFilesTest {
	@Rule public TemporaryFolder temporary = new TemporaryFolder();

	@Test public void countsPartialReadsWithoutAvailableOrPadding() throws Exception {
		byte[] expected = new byte[131077];
		for (int i = 0; i < expected.length; i++) expected[i] = (byte) (i * 31);
		InputStream input = new ByteArrayInputStream(expected) {
			@Override public int available() { throw new AssertionError("available is not file size"); }
			@Override public synchronized int read(byte[] bytes, int off, int count) {
				return super.read(bytes, off, Math.min(count, 7));
			}
		};
		ByteArrayOutputStream output = new ByteArrayOutputStream();
		assertEquals(expected.length, ChooserFiles.copy(input, output, expected.length, () -> false));
		assertArrayEquals(expected, output.toByteArray());
	}

	@Test public void unknownSizesCannotBypassLimitAndZeroMeansUnlimited() throws Exception {
		byte[] bytes = new byte[100];
		IOException error = assertThrows(IOException.class, () -> ChooserFiles.copy(new ByteArrayInputStream(bytes), new ByteArrayOutputStream(), 99, () -> false));
		assertTrue(error.getMessage().startsWith("FILE_TOO_LARGE:"));
		assertEquals(100, ChooserFiles.copy(new ByteArrayInputStream(bytes), new ByteArrayOutputStream(), 0, () -> false));
		assertEquals(0, ChooserFiles.copy(new ByteArrayInputStream(new byte[0]), new ByteArrayOutputStream(), 1, () -> false));
	}

	@Test public void zeroLengthReadsMakeProgressAndResetStopsCopy() throws Exception {
		InputStream input = new ByteArrayInputStream(new byte[]{1, 2, 3}) {
			@Override public synchronized int read(byte[] b, int off, int len) { return 0; }
		};
		ByteArrayOutputStream output = new ByteArrayOutputStream();
		assertEquals(3, ChooserFiles.copy(input, output, 3, () -> false));
		assertArrayEquals(new byte[]{1, 2, 3}, output.toByteArray());
		AtomicInteger checks = new AtomicInteger();
		assertThrows(IOException.class, () -> ChooserFiles.copy(new ByteArrayInputStream(new byte[200000]), new ByteArrayOutputStream(), 0, () -> checks.incrementAndGet() > 1));
		assertThrows(IOException.class, () -> ChooserFiles.copy(null, output, 0, () -> false));
	}

	@Test public void releaseCannotEscapeOwnedDirectoryOrFollowSymlinks() throws Exception {
		File cache = temporary.newFolder();
		File source = temporary.newFile();
		Files.write(source.toPath(), new byte[]{42});
		File copy = ChooserFiles.create(cache);
		assertThrows(IOException.class, () -> ChooserFiles.release(cache, "../" + source.getName()));
		assertThrows(IOException.class, () -> ChooserFiles.release(cache, source.toURI().toString()));
		ChooserFiles.release(cache, copy.getName());
		ChooserFiles.release(cache, copy.getName());
		assertTrue(source.exists());
		assertFalse(copy.exists());
		Files.createSymbolicLink(copy.toPath(), source.toPath());
		assertThrows(IOException.class, () -> ChooserFiles.release(cache, copy.getName()));
		assertArrayEquals(new byte[]{42}, Files.readAllBytes(source.toPath()));
		Files.delete(copy.toPath());
		assertTrue(copy.mkdir());
		assertThrows(IOException.class, () -> ChooserFiles.release(cache, copy.getName()));
	}

	@Test public void unwritableOutputPropagatesFailure() {
		assertThrows(IOException.class, () -> ChooserFiles.copy(new ByteArrayInputStream(new byte[]{1}), new java.io.OutputStream() {
			@Override public void write(int value) throws IOException { throw new IOException("disk full"); }
		}, 0, () -> false));
	}
}
