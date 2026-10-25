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
		Recorded(String id) { super(id, mock(CordovaWebView.class)); }
		@Override public synchronized void sendPluginResult(PluginResult result) {
			if (result.getStatus() != PluginResult.Status.NO_RESULT.ordinal()) finalResults.add(result);
		}
		synchronized PluginResult only() { assertEquals(1, finalResults.size()); return finalResults.get(0); }
	}

	public static class FixtureProvider extends ContentProvider {
		File source;
		int opens;
		boolean nullCursor;
		boolean failOpen;
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
		assertTrue(plugin.execute("getFile", new JSONArray().put(accept).put(data), callback));
		drain();
		return callback;
	}

	private Recorded copy(long limit, boolean multiple) throws Exception {
		return copy(limit, multiple, 0, 0);
	}

	private Recorded copy(long limit, boolean multiple, long maxFiles, long maxTotalSize) throws Exception {
		Recorded callback = new Recorded("copy");
		JSONObject options = new JSONObject().put("accept", "*/*").put("mode", "copy").put("multiple", multiple).put("maxFileSize", limit).put("localOnly", false).put("maxFiles", maxFiles).put("maxTotalSize", maxTotalSize);
		plugin.execute("pick", new JSONArray().put(options), callback);
		drain();
		return callback;
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
		assertEquals(callback.only().getStrMessage(), PluginResult.Status.OK.ordinal(), callback.only().getStatus());
		return new JSONObject(callback.only().getStrMessage());
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
		assertEquals(PluginResult.Status.ERROR.ordinal(), offline.only().getStatus());
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
		JSONArray files = new JSONArray(selected.only().getStrMessage());
		assertEquals(2, files.length());
		assertEquals(URI.toString(), files.getJSONObject(0).getString("sourceUri"));
		assertEquals("content://chooser.fixture/second", files.getJSONObject(1).getString("sourceUri"));
	}

	@Test public void resetSuppressesQueuedCopyAndReleaseCompletions() throws Exception {
		Recorded selected = copy(0, false);
		CountDownLatch resume = new CountDownLatch(1);
		worker.submit(() -> { try { resume.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {} });
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		ChooserTransaction.HOUSEKEEPING.submit(() -> { try { resume.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {} });
		Recorded released = new Recorded("old-release");
		plugin.execute("releaseFile", new JSONArray().put("00000000-0000-4000-8000-000000000000"), released);
		plugin.onReset();
		resume.countDown();
		drain();
		assertEquals(0, selected.finalResults.size());
		assertEquals(0, released.finalResults.size());
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
		assertTrue(failed.only().getStrMessage().startsWith("TOO_MANY_FILES:"));
		assertEquals(0, provider.opens);
		Recorded deduplicated = copy(0, true, 1, 0);
		plugin.onActivityResult(code, Activity.RESULT_OK, selection(URI, URI));
		drain();
		assertEquals(1, new JSONArray(deduplicated.only().getStrMessage()).length());
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
		assertTrue(restored.only().getStrMessage().startsWith("TOTAL_SIZE_EXCEEDED:"));
		assertEquals(2, provider.opens);
		assertEmptyCache();
	}

	@Test public void assetDescriptorSlicesArePreservedInCopiesAndLegacyData() throws Exception {
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
		assertEquals("AQID", object(data).getString("data"));
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
			assertEquals("RESULT_CANCELED", request.only().getStrMessage());
		}
		JSONObject options = new JSONObject().put("accept", "text/csv,application/json").put("mode", "metadata").put("multiple", true).put("localOnly", false);
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
		assertArrayEquals(pdf, android.util.Base64.decode(object(data).getString("data"), android.util.Base64.DEFAULT));
		assertEquals(pdf.length, object(data).getLong("size"));
		Recorded copied = copy(0, false);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertArrayEquals(pdf, Files.readAllBytes(new File(Uri.parse(object(copied).getString("uri")).getPath()).toPath()));
		Files.write(provider.source.toPath(), new byte[0]);
		Recorded empty = start(true);
		plugin.onActivityResult(code, Activity.RESULT_OK, new Intent().setData(URI));
		drain();
		assertEquals("", object(empty).getString("data"));
		assertEquals(0, object(empty).getLong("size"));
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
			assertTrue(copied.only().getStrMessage().length() < 16384);
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
			assertTrue(exceeded.only().getStrMessage().startsWith("FILE_TOO_LARGE:"));
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
		assertTrue(restored.only().getStrMessage().startsWith("READ_INTERRUPTED:"));
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
		assertTrue(blocked.only().getStrMessage().startsWith("BUSY:"));
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
		assertEquals("RESULT_CANCELED", event.getValue().getMultipartMessage(1).getStrMessage());
		assertEquals(0, provider.opens);
		assertNull(plugin.onSaveInstanceState());
	}
}
