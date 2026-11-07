package com.cyph.cordova;

import android.app.Activity;
import androidx.appcompat.app.AppCompatActivity;
import android.content.ContentProvider;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.os.CancellationSignal;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Comparator;
import java.util.stream.Stream;
import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaInterface;
import org.apache.cordova.CordovaInterfaceImpl;
import org.apache.cordova.CordovaPreferences;
import org.apache.cordova.PluginManager;
import org.apache.cordova.CoreAndroid;
import org.apache.cordova.CordovaWebView;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.robolectric.Shadows.shadowOf;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {24, 28, 30, 33, 35}, manifest = Config.NONE)
public class ChooserTest {
	private Chooser plugin;
	private AppCompatActivity activity;
	private CordovaInterface cordova;
	private ExecutorService worker;
	private FixtureProvider provider;
	private int code;
	private Intent launched;
	private static final Uri URI = Uri.parse("content://chooser.fixture/file");

	static class Recorded extends CallbackContext {
		final List<PluginResult> finalResults = new ArrayList<>();
		final CountDownLatch completed = new CountDownLatch(1);
		Recorded(String id) { super(id, mock(CordovaWebView.class)); }
		@Override public synchronized void sendPluginResult(PluginResult result) {
			if (result.getStatus() != PluginResult.Status.NO_RESULT.ordinal()) { finalResults.add(result); completed.countDown(); }
		}
		String message() { return payload(only()); }
		PluginResult only() {
			try { assertTrue("native callback did not settle", completed.await(5, TimeUnit.SECONDS)); }
			catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
			synchronized (this) { assertEquals(1, finalResults.size()); return finalResults.get(0); }
		}
	}

	private static String payload(PluginResult result) {
		return result.getStrMessage() != null ? result.getStrMessage() : result.getMessage();
	}

	public static class FixtureProvider extends ContentProvider {
		File source;
		int opens;
		boolean nullCursor;
		boolean failOpen;
		Runnable beforeOpen;
		boolean pipe;
		String displayName = "../source.bin";
		String mediaType;
		Long reportedSize;
		long offset;
		long length = AssetFileDescriptor.UNKNOWN_LENGTH;
		volatile CancellationSignal querySignal;
		volatile CancellationSignal openSignal;
		CountDownLatch queryStarted;
		CountDownLatch resumeQuery;
		@Override public boolean onCreate() { return true; }
		@Override public String getType(Uri uri) { return mediaType; }
		@Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
			if (nullCursor) return null;
			MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
			cursor.addRow(new Object[]{displayName, reportedSize});
			return cursor;
		}
		@Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort, CancellationSignal signal) {
			querySignal = signal;
			if (queryStarted != null) {
				queryStarted.countDown();
				try { if (!resumeQuery.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("fixture query timed out"); }
				catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
			}
			return query(uri, projection, selection, args, sort);
		}
		@Override public AssetFileDescriptor openAssetFile(Uri uri, String mode, CancellationSignal signal) throws FileNotFoundException {
			openSignal = signal;
			return new AssetFileDescriptor(openFile(uri, mode), offset, length);
		}
		@Override public AssetFileDescriptor openTypedAssetFile(Uri uri, String type, Bundle options, CancellationSignal signal) throws FileNotFoundException {
			return openAssetFile(uri, "r", signal);
		}
		@Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
			opens++;
			if (beforeOpen != null) beforeOpen.run();
			if (failOpen) throw new FileNotFoundException("offline");
			if (pipe) {
				try {
					ParcelFileDescriptor[] ends = ParcelFileDescriptor.createPipe();
					// Robolectric backs this pipe with a regular file: populate it
					// before handing it to the reader so EOF cannot race the writer.
					// Actual asynchronous pipe reads run in the emulator fixture.
					try (FileInputStream input = new FileInputStream(source);
							 FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(ends[1])) {
							byte[] buffer = new byte[65536];
							int count;
							while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
					}
					return ends[0];
				} catch (IOException error) { throw new FileNotFoundException(error.toString()); }
			}
			return ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY);
		}
		@Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
		@Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
		@Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
	}

	@Before public void setup() throws Exception {
		assertEquals("Robolectric must execute the requested API", Integer.getInteger("chooser.fixture.sdk", android.os.Build.VERSION.SDK_INT).intValue(), android.os.Build.VERSION.SDK_INT);
		activity = Robolectric.buildActivity(AppCompatActivity.class).get();
		worker = Executors.newSingleThreadExecutor();
		cordova = mock(CordovaInterface.class);
		when(cordova.getActivity()).thenReturn(activity);
		when(cordova.getContext()).thenReturn(activity);
		when(cordova.getThreadPool()).thenReturn(worker);
		doAnswer(call -> { launched = call.getArgument(1); code = call.getArgument(2); return null; }).when(cordova).startActivityForResult(any(), any(), anyInt());
		plugin = new Chooser();
		plugin.privateInitialize("Chooser", cordova, mock(CordovaWebView.class), new CordovaPreferences());
		provider = Robolectric.buildContentProvider(FixtureProvider.class).create("chooser.fixture").get();
		provider.source = File.createTempFile("chooser-source", ".bin", activity.getCacheDir());
		Files.write(provider.source.toPath(), new byte[]{1, 2, 3});
	}

	@After public void teardown() throws Exception {
		plugin.onReset();
		worker.shutdownNow();
		worker.awaitTermination(5, TimeUnit.SECONDS);
		File root = new File(activity.getCacheDir(), "cordova-plugin-chooser");
		ChooserTransaction.HOUSEKEEPING.submit(() -> {}).get(5, TimeUnit.SECONDS);
		if (root.exists()) try (Stream<Path> files = Files.walk(root.toPath())) {
			for (Path path : (Iterable<Path>) files.sorted(Comparator.reverseOrder())::iterator) Files.delete(path);
		}
		provider.source.delete();
	}

	private void drain() throws Exception {
		drain(5);
	}
	private void drain(int seconds) throws Exception {
		shadowOf(Looper.getMainLooper()).idle();
		worker.submit(() -> {}).get(seconds, TimeUnit.SECONDS);
		ChooserTransaction.HOUSEKEEPING.submit(() -> {}).get(5, TimeUnit.SECONDS);
	}

	private Recorded start(boolean data) throws Exception {
		return start("*/*", data);
	}
	private Recorded start(String accept, boolean data) throws Exception {
		Recorded callback = new Recorded("request");
		assertTrue(plugin.execute("pick", new JSONArray().put(options(accept, data ? "data" : "metadata", false)), callback));
		drain();
		return callback;
	}

	private Recorded copy(long limit, boolean multiple) throws Exception {
		return copy(limit, multiple, 0, 0);
	}

	private Recorded copy(long limit, boolean multiple, long maxFiles, long maxTotalSize) throws Exception {
		Recorded callback = new Recorded("copy");
		JSONObject options = options("*/*", "copy", multiple).put("maxFileSize", limit).put("localOnly", false).put("maxFiles", maxFiles).put("maxTotalSize", maxTotalSize);
		plugin.execute("pick", new JSONArray().put(options), callback);
		drain();
		return callback;
	}

	private JSONObject options(String accept, String mode, boolean multiple) throws Exception {
		return new JSONObject().put("requestId", java.util.UUID.randomUUID().toString()).put("source", "documents")
			.put("accept", accept).put("mode", mode).put("multiple", multiple).put("localOnly", true)
			.put("maxFileSize", 0).put("maxFiles", 0).put("maxTotalSize", 0);
	}

	private String errorCode(Recorded callback) throws Exception {
		assertEquals(PluginResult.Status.ERROR.ordinal(), callback.only().getStatus());
		return new JSONObject(callback.message()).getString("code");
	}

	private JSONObject chunk(String id, long offset, int length) throws Exception {
		Recorded callback = new Recorded("read");
		plugin.execute("readFile", new JSONArray().put(id).put(offset).put(length), callback);
		return object(callback);
	}

	private void assertEmptyCache() throws Exception {
		File root = ChooserFiles.directory(activity.getCacheDir());
		for (File file : root.listFiles()) {
			assertEquals(".pending", file.getName());
			assertEquals(0, file.list().length);
		}
	}

	private Intent selection(Uri... uris) {
		ClipData clip = ClipData.newRawUri("selection", uris[0]);
		for (int i = 1; i < uris.length; i++) clip.addItem(new ClipData.Item(uris[i]));
		Intent intent = new Intent();
		intent.setClipData(clip);
		return intent;
	}

	private JSONObject object(Recorded callback) throws Exception {
		assertEquals(callback.message(), PluginResult.Status.OK.ordinal(), callback.only().getStatus());
		return new JSONObject(callback.message());
	}

	@Test public void metadataDoesNotOpenFilesAndUnknownSizeIsNull() throws Exception {
		Recorded result = start(false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertEquals(0, provider.opens);
		assertEquals("../source.bin", object(result).getString("name"));
		assertTrue(object(result).isNull("size"));
		assertFalse(object(result).has("data"));
	}

	@Test public void nullIntentAndProviderFailureRejectExactlyOnce() throws Exception {
		Recorded missing = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, null);
		plugin.onActivityResult(code, Activity.RESULT_OK, null);
		assertEquals(PluginResult.Status.ERROR.ordinal(), missing.only().getStatus());
		provider.failOpen = true;
		Recorded offline = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		Recorded read = new Recorded("offline-read");
		plugin.execute("readFile", new JSONArray().put(object(offline).getString("id")).put(0).put(10), read);
		assertEquals("READ_FAILED", errorCode(read));
	}

	@Test public void busyAndStaleActivityResultsCannotStealCallbacks() throws Exception {
		Recorded original = start(false);
		int oldCode = code;
		Recorded busy = start(false);
		assertEquals(PluginResult.Status.ERROR.ordinal(), busy.only().getStatus());
		plugin.onReset();
		Recorded reserved = start(false);
		assertEquals(PluginResult.Status.ERROR.ordinal(), reserved.only().getStatus());
		plugin.onActivityResult(oldCode, Activity.RESULT_CANCELED, null);
		Recorded next = start(false);
		plugin.onActivityResult(oldCode, Activity.RESULT_CANCELED, null);
		assertEquals(0, next.finalResults.size());
		plugin.onActivityResult(code, Activity.RESULT_CANCELED, null);
		assertEquals(1, next.finalResults.size());
		assertEquals(0, original.finalResults.size());
	}

	@Test public void restoredCallbackReceivesTheOriginalReadMode() throws Exception {
		start(false);
		Bundle state = plugin.onSaveInstanceState();
		plugin.onReset();
		Recorded restored = new Recorded("restored");
		plugin.onRestoreStateForActivityResult(state, restored);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertFalse(object(restored).has("data"));
		assertEquals(0, provider.opens);
	}

	@Test public void copyUsesOwnedIdsAndReleaseLeavesSourceIntact() throws Exception {
		Recorded copied = copy(3, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		JSONObject result = object(copied);
		File output = new File(Uri.parse(result.getString("uri")).getPath());
		assertArrayEquals(new byte[]{1, 2, 3}, Files.readAllBytes(output.toPath()));
		assertEquals("cordova-plugin-chooser", output.getParentFile().getName());
		assertFalse(output.getName().contains("source"));
		Recorded released = new Recorded("release");
		plugin.execute("releaseFile", new JSONArray().put(result.getString("id")), released);
		drain();
		released.only();
		assertFalse(output.exists());
		assertTrue(provider.source.exists());
	}

	@Test public void countedLimitRejectsUnknownSizeAndCleansItsPartialCopy() throws Exception {
		provider.nullCursor = true;
		Recorded limited = copy(2, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertEquals(PluginResult.Status.ERROR.ordinal(), limited.only().getStatus());
		assertEmptyCache();
		Recorded unlimited = copy(0, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertEquals(3, object(unlimited).getLong("size"));
	}

	@Test public void multipleSelectionDeduplicatesAndPreservesOrder() throws Exception {
		Recorded selected = copy(0, true);
		ClipData clip = ClipData.newRawUri("first", URI);
		clip.addItem(new ClipData.Item(URI));
		clip.addItem(new ClipData.Item(Uri.parse("content://chooser.fixture/second")));
		Intent intent = new Intent();
		intent.setClipData(clip);
		plugin.onActivityResult(code, Activity.RESULT_OK, intent);
		drain();
		JSONArray files = new JSONArray(selected.message());
		assertEquals(2, files.length());
		assertEquals(URI.toString(), files.getJSONObject(0).getString("sourceUri"));
		assertEquals("content://chooser.fixture/second", files.getJSONObject(1).getString("sourceUri"));
	}

	@Test public void resetSuppressesQueuedCopyCompletion() throws Exception {
		Recorded selected = copy(0, false);
		CountDownLatch resume = new CountDownLatch(1);
		worker.submit(() -> { try { resume.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {} });
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		ChooserTransaction.HOUSEKEEPING.submit(() -> { try { resume.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {} });
		plugin.onReset();
		resume.countDown();
		drain();
		assertEquals(0, selected.finalResults.size());
		assertEmptyCache();
	}

	@Test public void launchFailureDoesNotLeavePluginBusy() throws Exception {
		when(cordova.getActivity()).thenReturn(null);
		Recorded failed = start(false);
		assertEquals(PluginResult.Status.ERROR.ordinal(), failed.only().getStatus());
		when(cordova.getActivity()).thenReturn(activity);
		Recorded next = start(false);
		plugin.onActivityResult(code, Activity.RESULT_CANCELED, null);
		assertEquals(PluginResult.Status.OK.ordinal(), next.only().getStatus());
	}

	@Test public void countLimitUsesDeduplicatedSelectionBeforeOpeningContents() throws Exception {
		Uri second = Uri.parse("content://chooser.fixture/second");
		Recorded failed = copy(0, true, 1, 0);
		plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, URI, second));
		drain();
		assertEquals("TOO_MANY_FILES", errorCode(failed));
		assertEquals(0, provider.opens);
		Recorded deduplicated = copy(0, true, 1, 0);
		plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, URI));
		drain();
		assertEquals(1, new JSONArray(deduplicated.message()).length());
	}

	@Test public void restoredCopyKeepsAllLimitsAndRollsBackAnExcessiveBatch() throws Exception {
		copy(8, true, 2, 5);
		Bundle state = plugin.onSaveInstanceState();
		assertEquals(8, state.getLong("limit"));
		assertEquals(2, state.getLong("maxFiles"));
		assertEquals(5, state.getLong("maxTotalSize"));
		plugin.onReset();
		Recorded restored = new Recorded("restored-copy");
		plugin.onRestoreStateForActivityResult(state, restored);
		plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, Uri.parse("content://chooser.fixture/second")));
		drain();
		assertEquals("TOTAL_SIZE_EXCEEDED", errorCode(restored));
		assertEquals(2, provider.opens);
		assertEmptyCache();
	}

	@Test public void assetDescriptorSlicesArePreservedInCopiesAndLazyData() throws Exception {
		Files.write(provider.source.toPath(), new byte[]{99, 98, 1, 2, 3, 97});
		provider.offset = 2;
		provider.length = 3;
		Recorded copied = copy(3, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		File output = new File(Uri.parse(object(copied).getString("uri")).getPath());
		assertArrayEquals(new byte[]{1, 2, 3}, Files.readAllBytes(output.toPath()));
		assertNotNull(provider.openSignal);
		Recorded data = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		JSONObject source = object(data);
		assertFalse(source.has("data"));
		assertEquals("AQID", chunk(source.getString("id"), 0, 32).getString("data"));
	}

	@Test public void filtersReachThePickerWithoutBroadeningSingleTypes() throws Exception {
		for (String accept : new String[]{"application/json", "text/csv", "application/pdf", "image/*", "video/*"}) {
			Recorded request = start(accept, false);
			Intent inner = launched.getParcelableExtra(Intent.EXTRA_INTENT);
			assertEquals(Intent.ACTION_GET_CONTENT, inner.getAction());
			assertTrue(inner.hasCategory(Intent.CATEGORY_OPENABLE));
			assertEquals(accept, inner.getType());
			assertNull(inner.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
			assertTrue(inner.getBooleanExtra(Intent.EXTRA_LOCAL_ONLY, false));
			plugin.onActivityResult(code, Activity.RESULT_CANCELED, null);
			assertEquals("RESULT_CANCELED", request.message());
		}
		JSONObject options = options("text/csv,application/json", "metadata", true).put("localOnly", false);
		Recorded request = new Recorded("plural-filter");
		plugin.execute("pick", new JSONArray().put(options), request);
		drain();
		Intent inner = launched.getParcelableExtra(Intent.EXTRA_INTENT);
		assertEquals("*/*", inner.getType());
		assertArrayEquals(new String[]{"text/csv", "application/json"}, inner.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
		assertTrue(inner.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
		assertFalse(inner.getBooleanExtra(Intent.EXTRA_LOCAL_ONLY, true));
		plugin.onActivityResult(code, Activity.RESULT_CANCELED, null);
		request.only();
	}

	@Test public void pdfBytesSurviveUnknownLengthPipesAndEmptyFilesRemainValid() throws Exception {
		byte[] pdf = new byte[]{37, 80, 68, 70, 45, 49, 46, 52, 10, 0, (byte)255};
		Files.write(provider.source.toPath(), pdf);
		provider.displayName = "sample.pdf";
		provider.mediaType = "application/pdf";
		provider.pipe = true;
		Recorded data = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		JSONObject source = object(data);
		assertEquals("source", source.getString("kind"));
		assertFalse(source.has("data"));
		assertArrayEquals(pdf, android.util.Base64.decode(chunk(source.getString("id"), 0, 32).getString("data"), android.util.Base64.DEFAULT));
		assertTrue(source.isNull("size"));
		Recorded copied = copy(0, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertArrayEquals(pdf, Files.readAllBytes(new File(Uri.parse(object(copied).getString("uri")).getPath()).toPath()));
		Files.write(provider.source.toPath(), new byte[0]);
		Recorded empty = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		JSONObject emptyChunk = chunk(object(empty).getString("id"), 0, 32);
		assertEquals("", emptyChunk.getString("data"));
		assertTrue(emptyChunk.getBoolean("eof"));
	}

	private static byte[] hash(File file) throws Exception {
		MessageDigest digest = MessageDigest.getInstance("SHA-256");
		try (FileInputStream input = new FileInputStream(file)) {
			byte[] buffer = new byte[65536];
			int count;
			while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
		}
		return digest.digest();
	}

	@Test public void largeCopiesKeepTheBridgePayloadSmallAndReleaseOnlyTheCopy() throws Exception {
		for (int mib : new int[]{45, 128}) {
			long size = mib * 1024L * 1024L;
			byte[] block = new byte[65536];
			for (int i = 0; i < block.length; i++) block[i] = (byte)(i % 251);
			try (FileOutputStream output = new FileOutputStream(provider.source)) {
				for (long written = 0; written < size; written += block.length) output.write(block);
			}
			provider.displayName = mib == 45 ? "sample.exe" : "sample.mp4";
			provider.reportedSize = 1L;
			Recorded copied = copy(size, false);
			plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
			drain(60);
			JSONObject result = object(copied);
			assertFalse(result.has("data"));
			assertFalse(result.has("dataURI"));
			assertTrue(copied.message().length() < 16384);
			assertEquals(size, result.getLong("size"));
			File output = new File(Uri.parse(result.getString("uri")).getPath());
			assertArrayEquals(hash(provider.source), hash(output));
			Recorded released = new Recorded("large-release");
			plugin.execute("releaseFile", new JSONArray().put(result.getString("id")), released);
			drain();
			assertEquals(PluginResult.Status.OK.ordinal(), released.only().getStatus());
			assertFalse(output.exists());
			assertEquals(size, provider.source.length());
			Recorded exceeded = copy(size - 1, false);
			plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
			drain(60);
			assertEquals("FILE_TOO_LARGE", errorCode(exceeded));
			assertEmptyCache();
		}
	}

	@Test public void releaseDoesNotWaitForBlockedProviderAndResetCancelsItsQuery() throws Exception {
		Recorded copied = copy(0, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		JSONObject reference = object(copied);
		File output = new File(Uri.parse(reference.getString("uri")).getPath());
		Recorded blocked = start(false);
		provider.queryStarted = new CountDownLatch(1);
		provider.resumeQuery = new CountDownLatch(1);
		try {
			plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
			assertTrue(provider.queryStarted.await(5, TimeUnit.SECONDS));
			Recorded released = new Recorded("independent-release");
			plugin.execute("releaseFile", new JSONArray().put(reference.getString("id")), released);
			ChooserTransaction.HOUSEKEEPING.submit(() -> {}).get(5, TimeUnit.SECONDS);
			assertEquals(PluginResult.Status.OK.ordinal(), released.only().getStatus());
			assertFalse(output.exists());
			plugin.onReset();
			for (int attempt = 0; attempt < 100 && !provider.querySignal.isCanceled(); attempt++) Thread.sleep(10);
			assertTrue(provider.querySignal.isCanceled());
		}
		finally { provider.resumeQuery.countDown(); }
		drain();
		assertEquals(0, blocked.finalResults.size());
	}

	@Test public void requestStateRejectsDuplicateCompletionAndCancellationIsRequestOwned() {
		ChooserRequest first = new ChooserRequest(new Recorded("first"), "*/*", ChooserRequest.Mode.COPY, false, false, 0, 1001);
		ChooserRequest second = new ChooserRequest(new Recorded("second"), "*/*", ChooserRequest.Mode.COPY, false, false, 0, 1002);
		assertEquals(ChooserRequest.State.SELECTING, first.state());
		assertTrue(first.process());
		assertFalse(first.process());
		assertTrue(first.complete());
		assertFalse(first.complete());
		first.finish();
		assertEquals(ChooserRequest.State.FINISHED, first.state());
		first.cancel();
		assertTrue(first.cancellation.isCanceled());
		assertFalse(second.cancellation.isCanceled());
		second.cancel();
		assertFalse(second.process());
		assertFalse(second.complete());
	}

	@Test public void invalidRestorationFailsOnceAndLeavesThePickerAvailable() throws Exception {
		Recorded original = start(false);
		Bundle state = plugin.onSaveInstanceState();
		state.putString("mode", "unknown");
		Recorded restored = new Recorded("invalid-restoration");
		plugin.onRestoreStateForActivityResult(state, restored);
		assertEquals("READ_INTERRUPTED", errorCode(restored));
		plugin.onActivityResult(code, Activity.RESULT_CANCELED, null);
		assertEquals(0, original.finalResults.size());
		Recorded next = start(false);
		plugin.onActivityResult(code, Activity.RESULT_CANCELED, null);
		assertEquals(PluginResult.Status.OK.ordinal(), next.only().getStatus());
	}

	@Test public void realDispatcherRetainsTheOldPickerUntilItDrains() throws Exception {
		CordovaInterfaceImpl dispatcher = new CordovaInterfaceImpl(activity, worker);
		plugin = new Chooser();
		plugin.privateInitialize("Chooser", dispatcher, mock(CordovaWebView.class), new CordovaPreferences());
		Recorded first = start(false);
		int oldCode = plugin.onSaveInstanceState().getInt("code");
		dispatcher.setActivityResultRequestCode(oldCode);
		plugin.onReset();
		Recorded blocked = start(false);
		assertEquals("BUSY", errorCode(blocked));
		assertTrue(dispatcher.onActivityResult(oldCode, Activity.RESULT_OK, new Intent().setData(URI)));
		assertEquals(0, first.finalResults.size());
		Recorded next = start(false);
		int newCode = plugin.onSaveInstanceState().getInt("code");
		assertNotEquals(oldCode, newCode);
		dispatcher.setActivityResultRequestCode(newCode);
		assertTrue(dispatcher.onActivityResult(newCode, Activity.RESULT_OK, new Intent().setData(URI)));
		drain();
		assertEquals("../source.bin", object(next).getString("name"));
	}

	@Test public void realDispatcherRestoresAbandonedPickerAsCancellationWithoutReading() throws Exception {
		CordovaInterfaceImpl original = new CordovaInterfaceImpl(activity, worker);
		plugin = new Chooser();
		plugin.privateInitialize("Chooser", original, mock(CordovaWebView.class), new CordovaPreferences());
		start(true);
		plugin.onReset();
		Bundle pickerState = plugin.onSaveInstanceState();
		assertTrue(pickerState.getBoolean("abandoned"));
		Bundle saved = new Bundle();
		saved.putString("callbackService", "Chooser");
		Bundle plugins = new Bundle();
		plugins.putBundle("Chooser", pickerState);
		saved.putBundle("plugin", plugins);
		CordovaInterfaceImpl restored = new CordovaInterfaceImpl(activity, worker);
		restored.restoreInstanceState(saved);
		PluginManager manager = mock(PluginManager.class);
		CoreAndroid core = mock(CoreAndroid.class);
		when(manager.getPlugin(CoreAndroid.PLUGIN_NAME)).thenReturn(core);
		plugin = new Chooser();
		plugin.privateInitialize("Chooser", restored, mock(CordovaWebView.class), new CordovaPreferences());
		when(manager.getPlugin("Chooser")).thenReturn(plugin);
		restored.onActivityResult(pickerState.getInt("code"), Activity.RESULT_OK, new Intent().setData(URI));
		restored.onCordovaInit(manager);
		drain();
		org.mockito.ArgumentCaptor<PluginResult> event = org.mockito.ArgumentCaptor.forClass(PluginResult.class);
		verify(core, times(1)).sendResumeEvent(event.capture());
		assertEquals("CANCELLED", new JSONObject(payload(event.getValue().getMultipartMessage(1))).getString("code"));
		assertEquals(0, provider.opens);
		assertNull(plugin.onSaveInstanceState());
	}
	@Test public void lazySourcesDoNotReadAtSelectionAndEnforceActualBudgets() throws Exception {
		provider.reportedSize = 1L;
		Recorded selected = new Recorded("source-budget");
		plugin.execute("pick", new JSONArray().put(options("*/*", "data", true).put("maxFileSize", 3).put("maxTotalSize", 4)), selected);
		drain();
		plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, Uri.parse("content://chooser.fixture/other")));
		drain();
		JSONArray sources = new JSONArray(selected.message());
		assertEquals(0, provider.opens);
		for (int i = 0; i < sources.length(); i++) {
			assertEquals("source", sources.getJSONObject(i).getString("kind"));
			assertFalse(sources.getJSONObject(i).has("data"));
			assertFalse(sources.getJSONObject(i).has("uri"));
		}
		String first = sources.getJSONObject(0).getString("id");
		String second = sources.getJSONObject(1).getString("id");
		assertEquals("AQID", chunk(first, 0, 32).getString("data"));
		assertEquals(1, provider.opens);
		Recorded failed = new Recorded("aggregate-limit");
		plugin.execute("readFile", new JSONArray().put(second).put(0).put(32), failed);
		assertEquals("TOTAL_SIZE_EXCEEDED", errorCode(failed));
		for (String id : new String[]{first, second}) {
			Recorded released = new Recorded("release-source");
			plugin.execute("releaseFile", new JSONArray().put(id), released);
			assertEquals(PluginResult.Status.OK.ordinal(), released.only().getStatus());
		}
		assertTrue(provider.source.exists());
		assertEmptyCache();
	}

	@Test public void managedStatAndChunksRestoreExistingRc1Files() throws Exception {
		File existing = ChooserFiles.create(activity.getCacheDir());
		Files.write(existing.toPath(), new byte[]{0, (byte)255, 42, 17, 5});
		Recorded stat = new Recorded("stat");
		plugin.execute("statFile", new JSONArray().put(existing.getName()), stat);
		JSONObject result = object(stat);
		assertEquals(existing.getName(), result.getString("id"));
		assertEquals(5, result.getLong("size"));
		assertEquals(Uri.fromFile(existing).toString(), result.getString("uri"));
		assertArrayEquals(new byte[]{42, 17}, android.util.Base64.decode(chunk(existing.getName(), 2, 2).getString("data"), android.util.Base64.DEFAULT));
		assertEquals("AP8q", chunk(existing.getName(), 0, 3).getString("data"));
		assertTrue(chunk(existing.getName(), 5, 10).getBoolean("eof"));
	}

	@Test public void countLimitAppliesToMetadataAndSourcesBeforeAnyProviderReads() throws Exception {
		for (String mode : new String[]{"metadata", "data"}) {
			Recorded selected = new Recorded(mode);
			plugin.execute("pick", new JSONArray().put(options("*/*", mode, true).put("maxFiles", 1)), selected);
			drain();
			plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, Uri.parse("content://chooser.fixture/other")));
			assertEquals("TOO_MANY_FILES", errorCode(selected));
		}
		assertEquals(0, provider.opens);
	}

	@Test public void signalCancellationMatchesRequestIdAndKeepsDispatcherOwnership() throws Exception {
		JSONObject options = options("*/*", "copy", false);
		Recorded selected = new Recorded("signal-selection");
		plugin.execute("pick", new JSONArray().put(options), selected);
		drain();
		int oldCode = code;
		Recorded stale = new Recorded("stale-cancel");
		plugin.execute("cancelPick", new JSONArray().put("another-request"), stale);
		stale.only();
		assertEquals(0, selected.finalResults.size());
		CountDownLatch finishRequested = new CountDownLatch(1);
		AppCompatActivity finishHost = mock(AppCompatActivity.class);
		doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(finishHost).runOnUiThread(any(Runnable.class));
		doAnswer(call -> { finishRequested.countDown(); return null; }).when(finishHost).finishActivity(oldCode);
		when(cordova.getActivity()).thenReturn(finishHost);
		Recorded cancelled = new Recorded("cancel");
		plugin.execute("cancelPick", new JSONArray().put(options.getString("requestId")), cancelled);
		cancelled.only();
		assertTrue(finishRequested.await(5, TimeUnit.SECONDS));
		assertEquals("Cancellation must wait for the reserved activity result", 0, selected.finalResults.size());
		Recorded reserved = start(false);
		assertEquals("BUSY", errorCode(reserved));
		plugin.onActivityResult(oldCode, Activity.RESULT_OK, new Intent().setData(URI));
		assertEquals("CANCELLED", errorCode(selected));
		assertEquals("signal", new JSONObject(selected.message()).getString("reason"));
		when(cordova.getActivity()).thenReturn(activity);
		Recorded next = start(false);
		assertNotEquals(oldCode, code);
		plugin.onActivityResult(oldCode, Activity.RESULT_OK, new Intent().setData(URI));
		assertEquals(0, next.finalResults.size());
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		assertEquals("../source.bin", object(next).getString("name"));
		assertEquals(0, provider.opens);
	}

	@Test public void realDispatcherAllowsReopeningAfterSignalCancellationSettles() throws Exception {
		CordovaInterfaceImpl dispatcher = new CordovaInterfaceImpl(activity, worker);
		plugin = new Chooser();
		plugin.privateInitialize("Chooser", dispatcher, mock(CordovaWebView.class), new CordovaPreferences());
		JSONObject options = options("*/*", "metadata", false);
		Recorded selected = new Recorded("dispatcher-cancel");
		plugin.execute("pick", new JSONArray().put(options), selected);
		drain();
		int oldCode = plugin.onSaveInstanceState().getInt("code");
		dispatcher.setActivityResultRequestCode(oldCode);
		Recorded cancelled = new Recorded("cancel");
		plugin.execute("cancelPick", new JSONArray().put(options.getString("requestId")), cancelled);
		cancelled.only();
		assertEquals(0, selected.finalResults.size());
		assertTrue(dispatcher.onActivityResult(oldCode, Activity.RESULT_CANCELED, null));
		assertEquals("CANCELLED", errorCode(selected));
		assertEquals("signal", new JSONObject(selected.message()).getString("reason"));
		Recorded next = start(false);
		int newCode = plugin.onSaveInstanceState().getInt("code");
		assertNotEquals(oldCode, newCode);
		dispatcher.setActivityResultRequestCode(newCode);
		assertTrue(dispatcher.onActivityResult(newCode, Activity.RESULT_OK, new Intent().setData(URI)));
		assertEquals("../source.bin", object(next).getString("name"));
		assertEquals(0, provider.opens);
	}

	@Test public void signalCancellationBeforeLaunchSettlesWithoutAnActivityResult() throws Exception {
		List<Runnable> launches = new ArrayList<>();
		AppCompatActivity delayedHost = mock(AppCompatActivity.class);
		doAnswer(call -> { launches.add(call.getArgument(0)); return null; }).when(delayedHost).runOnUiThread(any(Runnable.class));
		when(cordova.getActivity()).thenReturn(delayedHost);
		JSONObject options = options("*/*", "metadata", false);
		Recorded selected = new Recorded("before-launch");
		plugin.execute("pick", new JSONArray().put(options), selected);
		assertEquals(1, launches.size());
		assertNull(launched);
		Recorded cancelled = new Recorded("cancel-before-launch");
		plugin.execute("cancelPick", new JSONArray().put(options.getString("requestId")), cancelled);
		cancelled.only();
		assertEquals("CANCELLED", errorCode(selected));
		assertEquals("signal", new JSONObject(selected.message()).getString("reason"));
		launches.get(0).run();
		assertNull(launched);
		when(cordova.getActivity()).thenReturn(activity);
		Recorded next = start(false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		assertEquals("../source.bin", object(next).getString("name"));
	}

	@Test public void cancellationDuringProviderProcessingRollsBackBeforeCallback() throws Exception {
		JSONObject options = options("*/*", "copy", false);
		Recorded selected = new Recorded("processing-cancel");
		plugin.execute("pick", new JSONArray().put(options), selected);
		drain();
		provider.queryStarted = new CountDownLatch(1);
		provider.resumeQuery = new CountDownLatch(1);
		try {
			plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
			assertTrue(provider.queryStarted.await(5, TimeUnit.SECONDS));
			Recorded canceled = new Recorded("cancel");
			plugin.execute("cancelPick", new JSONArray().put(options.getString("requestId")), canceled);
			canceled.only();
			assertEquals(0, selected.finalResults.size());
		}
		finally { provider.resumeQuery.countDown(); }
		assertEquals("CANCELLED", errorCode(selected));
		assertEmptyCache();
	}

	@Test public void photoContractsProvideMediaFiltersAndKeepPluralSingleLimit() throws Exception {
		for (String media : new String[]{"image", "video"}) {
			JSONObject options = options("*/*", "metadata", true).put("source", "photos")
				.put("mediaTypes", new JSONArray().put(media)).put("maxFiles", 1);
			Recorded selected = new Recorded("photos");
			plugin.execute("pick", new JSONArray().put(options), selected);
			drain();
			assertNotEquals(Intent.ACTION_CHOOSER, launched.getAction());
			assertEquals(media + "/*", launched.getType());
			assertFalse(launched.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
			if (android.os.Build.VERSION.SDK_INT < 33) {
				assertEquals(Intent.ACTION_OPEN_DOCUMENT, launched.getAction());
				assertTrue(launched.hasCategory(Intent.CATEGORY_OPENABLE));
			}
			Bundle saved = plugin.onSaveInstanceState();
			assertEquals("photos", saved.getString("source"));
			assertArrayEquals(new String[]{media}, saved.getStringArray("mediaTypes"));
			plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
			drain();
			assertEquals(1, new JSONArray(selected.message()).length());
		}
		JSONObject options = options("*/*", "metadata", true).put("source", "photos")
			.put("mediaTypes", new JSONArray().put("image").put("video")).put("maxFiles", 2);
		Recorded selected = new Recorded("photos-many");
		plugin.execute("pick", new JSONArray().put(options), selected);
		drain();
		if (Intent.ACTION_OPEN_DOCUMENT.equals(launched.getAction())) {
			assertTrue(launched.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
			assertArrayEquals(new String[]{"image/*", "video/*"}, launched.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
		}
		plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, Uri.parse("content://chooser.fixture/2"), Uri.parse("content://chooser.fixture/3")));
		assertEquals("TOO_MANY_FILES", errorCode(selected));
		assertEquals(0, provider.opens);
	}

	@Test public void photoFallbackIsOpenableForSingleBoundedAndUnlimitedSelections() throws Exception {
		for (long[] selection : new long[][]{{0, 0}, {1, 1}, {1, 2}, {1, 0}}) {
			boolean multiple = selection[0] != 0;
			long maxFiles = selection[1];
			ChooserRequest request = new ChooserRequest(new Recorded("photo-intent"), "*/*", ChooserRequest.Mode.METADATA,
				multiple, false, 0, maxFiles, 0, 1001, "photo-intent", "photos", new String[]{"image", "video"});
			Intent intent = plugin.pickerIntent(request);
			boolean documents = Intent.ACTION_OPEN_DOCUMENT.equals(intent.getAction());
			if (android.os.Build.VERSION.SDK_INT < 33) assertTrue(documents);
			assertEquals("Only the document fallback needs OPENABLE", documents, intent.hasCategory(Intent.CATEGORY_OPENABLE));
			if (documents) {
				assertEquals(multiple && maxFiles != 1, intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
				assertArrayEquals(new String[]{"image/*", "video/*"}, intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
			}
		}
	}

	@Test public void invalidWireValuesAreRejectedBeforeOpeningThePicker() throws Exception {
		for (Object value : new Object[]{-1, 0.5, 9007199254740992D, "3", JSONObject.NULL}) {
			Recorded rejected = new Recorded("invalid-limit");
			plugin.execute("pick", new JSONArray().put(options("*/*", "copy", false).put("maxFileSize", value)), rejected);
			assertEquals("INVALID_ARGUMENT", errorCode(rejected));
		}
		Recorded source = new Recorded("invalid-source");
		plugin.execute("pick", new JSONArray().put(options("*/*", "copy", false).put("source", "camera")), source);
		assertEquals("INVALID_ARGUMENT", errorCode(source));
		assertNull(launched);
	}

	@Test public void cancelReadIsSourceOnlyAndProducesTypedCancellation() throws Exception {
		Recorded selected = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		String id = object(selected).getString("id");
		assertEquals("AQ==", chunk(id, 0, 1).getString("data"));
		Recorded cancel = new Recorded("cancel-source");
		plugin.execute("cancelRead", new JSONArray().put(id), cancel);
		assertEquals(PluginResult.Status.OK.ordinal(), cancel.only().getStatus());
		Recorded read = new Recorded("cancelled-read");
		plugin.execute("readFile", new JSONArray().put(id).put(1).put(1), read);
		assertEquals("CANCELLED", errorCode(read));
		assertEquals("signal", new JSONObject(read.message()).getString("reason"));
		Recorded released = new Recorded("release-source");
		plugin.execute("releaseFile", new JSONArray().put(id), released);
		released.only();
		File managed = ChooserFiles.create(activity.getCacheDir());
		Recorded rejected = new Recorded("reject-managed-cancel");
		plugin.execute("cancelRead", new JSONArray().put(managed.getName()), rejected);
		assertEquals("INVALID_ARGUMENT", errorCode(rejected));
		assertTrue(managed.exists());
		assertTrue(provider.source.exists());
	}

	@Test public void requestCancellationClosesAnActiveCopyAndLateProviderStreams() throws Exception {
		ChooserRequest request = new ChooserRequest(new Recorded("copy-cancel"), "*/*", ChooserRequest.Mode.COPY, false, false, 0, 1001);
		java.util.concurrent.atomic.AtomicInteger closes = new java.util.concurrent.atomic.AtomicInteger();
		java.io.InputStream input = new java.io.ByteArrayInputStream(new byte[]{1}) {
			@Override public void close() { closes.incrementAndGet(); }
		};
		request.attachInput(input);
		request.cancel();
		assertTrue(request.cancellation.isCanceled());
		assertEquals(1, closes.get());
		request.detachInput(input);
		assertThrows(ChooserError.class, () -> request.attachInput(input));
		assertEquals(2, closes.get());
	}

	@Test public void rollbackFailurePreservesOriginalErrorAndSignalCancellation() throws Exception {
		for (boolean cancel : new boolean[]{false, true}) {
			java.util.concurrent.atomic.AtomicReference<File> blockedJournal = new java.util.concurrent.atomic.AtomicReference<>();
			CountDownLatch opened = new CountDownLatch(1);
			CountDownLatch resumeOpen = new CountDownLatch(1);
			provider.beforeOpen = () -> {
				File pending = new File(activity.getCacheDir(), "cordova-plugin-chooser/.pending");
				File[] transactions = pending.listFiles(File::isDirectory);
				assertNotNull(transactions);
				assertEquals(1, transactions.length);
				File journal = new File(transactions[0], "journal.tmp");
				assertTrue(journal.mkdir()); // Force rollback's journal write to fail.
				blockedJournal.set(journal);
				opened.countDown();
				if (cancel) {
					try { assertTrue(resumeOpen.await(5, TimeUnit.SECONDS)); }
					catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
				}
			};
			JSONObject options = options("*/*", "copy", false).put("maxFileSize", cancel ? 0 : 1);
			Recorded selected = new Recorded("rollback-failure");
			try {
				plugin.execute("pick", new JSONArray().put(options), selected);
				drain();
				plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
				assertTrue(opened.await(5, TimeUnit.SECONDS));
				if (cancel) {
					Recorded cancelled = new Recorded("cancel-before-rollback");
					plugin.execute("cancelPick", new JSONArray().put(options.getString("requestId")), cancelled);
					cancelled.only();
					resumeOpen.countDown();
				}
				assertEquals("CLEANUP_FAILED", errorCode(selected));
				JSONObject failure = new JSONObject(selected.message());
				JSONObject outcome = failure.getJSONObject("outcome");
				assertEquals("rejected", outcome.getString("status"));
				JSONObject original = outcome.getJSONObject("reason");
				assertEquals(cancel ? "CANCELLED" : "FILE_TOO_LARGE", original.getString("code"));
				assertEquals(cancel ? "File selection was cancelled." : "Selected file exceeds the byte limit.", original.getString("message"));
				if (cancel) assertEquals("signal", original.getString("reason"));
				JSONArray failures = failure.getJSONArray("failures");
				assertEquals(1, failures.length());
				assertTrue(ChooserFiles.isId(failures.getJSONObject(0).getString("id")));
				assertEquals("RELEASE_FAILED", failures.getJSONObject(0).getJSONObject("error").getString("code"));
			}
			finally {
				resumeOpen.countDown();
				provider.beforeOpen = null;
				drain();
				if (blockedJournal.get() != null) assertTrue(blockedJournal.get().delete());
				ChooserTransaction.recover(activity.getCacheDir(), ChooserTransaction.FILES);
			}
			assertEmptyCache();
		}
	}

}
