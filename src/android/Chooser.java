package com.cyph.cordova;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia;
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class Chooser extends CordovaPlugin {
	private final Object lock = new Object();
	private ChooserRequest active;
	private ChooserRequest pendingPicker;
	private int nextRequestCode = 1000;
	private long generation;
	private ChooserResources resources;
	private static final ExecutorService READS = Executors.newFixedThreadPool(4, action -> daemon(action, "Chooser-read"));
	private static final ExecutorService CLEANUP = Executors.newCachedThreadPool(action -> daemon(action, "Chooser-release"));
	private static Thread daemon(Runnable action, String name) {
		Thread thread = new Thread(action, name);
		thread.setDaemon(true);
		return thread;
	}
	private ChooserResources resources() {
		synchronized (lock) {
			if (resources == null) resources = new ChooserResources(cordova.getContext().getCacheDir());
			return resources;
		}
	}

	@Override
	public boolean execute(String action, JSONArray args, CallbackContext callback) {
		if ("readFile".equals(action) || "statFile".equals(action) || "releaseFile".equals(action) || "cancelRead".equals(action)) {
			resourceAction(action, args, callback);
			return true;
		}
		if ("cancelPick".equals(action)) {
			try {
				if (args.length() != 1 || !(args.get(0) instanceof String)) throw new JSONException("Expected a request id.");
				cancelPick(args.getString(0));
				callback.success();
			}
			catch (Exception error) { callback.sendPluginResult(failure(error, ChooserError.Code.INVALID_ARGUMENT)); }
			return true;
		}
		if (!"pick".equals(action)) return false;
		try {
			if (args.length() != 1) throw new JSONException("Expected picker options.");
			JSONObject options = args.getJSONObject(0);
			String requestId = stringOption(options, "requestId");
			String source = stringOption(options, "source");
			if (requestId.isEmpty() || requestId.length() > 256 || !("documents".equals(source) || "photos".equals(source))) throw new JSONException("Invalid request id or source.");
			String accept = stringOption(options, "accept").toLowerCase(Locale.ROOT).replaceAll("\\s", "");
			if (accept.isEmpty()) accept = "*/*";
			for (String type : accept.split(",", -1)) {
				if (!type.matches("(?:\\*|[a-z0-9!#$&^_.+-]+)/(?:\\*|[a-z0-9!#$&^_.+-]+)") || (type.startsWith("*/") && !"*/*".equals(type))) throw new JSONException("Invalid MIME filter.");
			}
			ChooserRequest.Mode mode = ChooserRequest.Mode.parse(stringOption(options, "mode"));
			if (!(options.get("multiple") instanceof Boolean) || !(options.get("localOnly") instanceof Boolean)) throw new JSONException("Invalid picker booleans.");
			String[] mediaTypes = photoTypes(options, source);
			long limit = number(options.get("maxFileSize"));
			long maxFiles = number(options.get("maxFiles"));
			long maxTotalSize = number(options.get("maxTotalSize"));
			final ChooserRequest request;
			synchronized (lock) {
				if (active != null || pendingPicker != null) {
					callback.sendPluginResult(error(ChooserError.Code.BUSY, "A file picker is already active."));
					return true;
				}
				nextRequestCode = nextRequestCode == 32767 ? 1000 : nextRequestCode + 1;
				request = new ChooserRequest(callback, accept, mode, options.getBoolean("multiple"), options.getBoolean("localOnly"), limit, maxFiles, maxTotalSize, nextRequestCode, requestId, source, mediaTypes);
				active = request;
				PluginResult pending = new PluginResult(PluginResult.Status.NO_RESULT);
				pending.setKeepCallback(true);
				callback.sendPluginResult(pending);
			}
			try { cordova.getActivity().runOnUiThread(() -> launch(request)); }
			catch (Exception error) { finish(request, failure(error, ChooserError.Code.PICKER_FAILED)); }
		}
		catch (Exception error) { callback.sendPluginResult(failure(error, ChooserError.Code.INVALID_ARGUMENT)); }
		return true;
	}

	private static String stringOption(JSONObject value, String name) throws JSONException {
		Object result = value.get(name);
		if (!(result instanceof String)) throw new JSONException("Expected a string option.");
		return (String) result;
	}
	private static String[] photoTypes(JSONObject options, String source) throws JSONException {
		if (!"photos".equals(source)) return new String[]{"image", "video"};
		JSONArray types = options.getJSONArray("mediaTypes");
		Set<String> selected = new LinkedHashSet<>();
		for (int i = 0; i < types.length(); i++) {
			Object type = types.get(i);
			if (!(type instanceof String) || !("image".equals(type) || "video".equals(type))) throw new JSONException("Invalid photo media type.");
			selected.add((String) type);
		}
		if (selected.isEmpty()) throw new JSONException("Expected photo media types.");
		return selected.toArray(new String[0]);
	}
	private static long number(Object value) throws JSONException {
		if (!(value instanceof Number)) throw new JSONException("Expected a nonnegative safe integer.");
		double number = ((Number) value).doubleValue();
		if (!Double.isFinite(number) || number < 0 || number > ChooserFiles.MAX_SAFE_INTEGER || number != Math.floor(number)) throw new JSONException("Expected a nonnegative safe integer.");
		return (long) number;
	}

	private void resourceAction(String action, JSONArray args, CallbackContext callback) {
		try {
			if (args.length() != ("readFile".equals(action) ? 3 : 1) || !(args.get(0) instanceof String)) throw new JSONException("Expected a file id.");
			String id = args.getString(0);
			if (!ChooserFiles.isId(id)) throw new JSONException("Expected a managed file id.");
			long offset = "readFile".equals(action) ? number(args.get(1)) : 0;
			long length = "readFile".equals(action) ? number(args.get(2)) : 0;
			if (length > ChooserResources.MAX_CHUNK || offset > ChooserFiles.MAX_SAFE_INTEGER - length) throw new JSONException("Invalid chunk range.");
			ChooserResources owned = resources();
			final long owner;
			synchronized (lock) { owner = generation; }
			if ("releaseFile".equals(action)) owned.beginRelease(id);
			if ("cancelRead".equals(action)) owned.beginCancelRead(id);
			ExecutorService executor = "readFile".equals(action) ? READS : ("releaseFile".equals(action) || "cancelRead".equals(action)) ? CLEANUP : ChooserTransaction.HOUSEKEEPING;
			executor.execute(() -> {
				PluginResult result;
				try {
					if ("cancelRead".equals(action)) {
						owned.cancelRead(id);
						result = new PluginResult(PluginResult.Status.OK);
					}
					else if ("releaseFile".equals(action)) {
						owned.release(id);
						result = new PluginResult(PluginResult.Status.OK);
					}
					else if ("statFile".equals(action)) {
						ChooserResources.Stat stat = owned.stat(id);
						result = new PluginResult(PluginResult.Status.OK, new JSONObject().put("id", id).put("uri", Uri.fromFile(stat.file).toString()).put("size", stat.size));
					}
					else {
						ChooserResources.Chunk chunk = owned.read(id, offset, (int) length);
						result = new PluginResult(PluginResult.Status.OK, new JSONObject().put("data", Base64.encodeToString(chunk.data, Base64.NO_WRAP)).put("eof", chunk.eof));
					}
				}
				catch (OutOfMemoryError error) { result = error(ChooserError.Code.OUT_OF_MEMORY, "Insufficient memory for a bounded read."); }
				catch (Exception error) { result = failure(error, "releaseFile".equals(action) ? ChooserError.Code.RELEASE_FAILED : ChooserError.Code.READ_FAILED); }
				synchronized (lock) { if (owner == generation) callback.sendPluginResult(result); }
			});
		}
		catch (Exception error) { callback.sendPluginResult(failure(error, ChooserError.Code.INVALID_ARGUMENT)); }
	}

	/** Use AndroidX's fallback selection while retaining Cordova's result/restoration dispatcher. */
	Intent pickerIntent(ChooserRequest request) {
		if ("photos".equals(request.source)) {
			PickVisualMedia.VisualMediaType type = request.mediaTypes.length > 1 ? PickVisualMedia.ImageAndVideo.INSTANCE :
				"image".equals(request.mediaTypes[0]) ? PickVisualMedia.ImageOnly.INSTANCE : PickVisualMedia.VideoOnly.INSTANCE;
			PickVisualMediaRequest input = new PickVisualMediaRequest.Builder().setMediaType(type).build();
			Intent intent;
			if (!request.multiple || request.maxFiles == 1) intent = new PickVisualMedia().createIntent(cordova.getContext(), input);
			// The platform caps its picker; the document fallback and post-selection validation enforce our own limit.
			else if (request.maxFiles == 0) intent = new PickMultipleVisualMedia().createIntent(cordova.getContext(), input);
			else {
				PickMultipleVisualMedia defaults = new PickMultipleVisualMedia();
				Intent defaultsIntent = defaults.createIntent(cordova.getContext(), input);
				int platformLimit = defaultsIntent.getIntExtra("android.provider.extra.PICK_IMAGES_MAX", Integer.MAX_VALUE);
				intent = new PickMultipleVisualMedia((int) Math.min(request.maxFiles, platformLimit)).createIntent(cordova.getContext(), input);
			}
			if (Intent.ACTION_OPEN_DOCUMENT.equals(intent.getAction())) intent.addCategory(Intent.CATEGORY_OPENABLE);
			return intent;
		}
		Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
		String[] types = request.accept.split(",");
		intent.setType(types.length == 1 ? types[0] : "*/*");
		if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
		intent.addCategory(Intent.CATEGORY_OPENABLE);
		intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, request.multiple);
		intent.putExtra(Intent.EXTRA_LOCAL_ONLY, request.localOnly);
		intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
		return Intent.createChooser(intent, "Select File");
	}
	private void launch(ChooserRequest request) {
		synchronized (lock) {
			if (active != request || request.canceled) return;
			try {
				Intent intent = pickerIntent(request);
				pendingPicker = request;
				cordova.startActivityForResult(this, intent, request.code);
			}
			catch (Exception error) {
				if (pendingPicker == request) pendingPicker = null;
				finish(request, failure(error, ChooserError.Code.PICKER_FAILED));
			}
		}
	}

	private void cancelPick(String id) {
		final ChooserRequest request;
		final boolean awaitingResult;
		synchronized (lock) {
			request = active;
			if (request == null || !request.requestId.equals(id) || request.canceled) return;
			awaitingResult = pendingPicker == request;
			request.canceled = true;
			if (!awaitingResult && request.state() == ChooserRequest.State.SELECTING) finishCancellation(request);
		}
		CLEANUP.execute(() -> {
			try { request.cancel(); } catch (RuntimeException ignored) {}
			if (awaitingResult) {
				// Settle only when this result drains, so the caller can safely open another picker.
				try { cordova.getActivity().runOnUiThread(() -> {
					synchronized (lock) {
						if (pendingPicker == request) {
							try { cordova.getActivity().finishActivity(request.code); }
							catch (RuntimeException ignored) { /* The picker can still return its result normally. */ }
						}
					}
				}); }
				catch (RuntimeException ignored) { /* Dispatcher reservation is retained until its result drains. */ }
			}
		});
	}

	@Override
	public void onActivityResult(int requestCode, int resultCode, Intent intent) {
		final ChooserRequest request;
		synchronized (lock) {
			request = pendingPicker;
			if (request == null || request.code != requestCode) return;
			pendingPicker = null;
			if (active != request) return;
			if (request.restoredAbandoned || request.canceled) { finishCancellation(request); return; }
			if (!request.process()) return;
		}
		if (resultCode == Activity.RESULT_CANCELED) {
			finishWithoutResources(request, new PluginResult(PluginResult.Status.OK, "RESULT_CANCELED"));
			return;
		}
		if (resultCode != Activity.RESULT_OK) { finishWithoutResources(request, error(ChooserError.Code.PICKER_FAILED, "Unexpected activity result.")); return; }
		try {
			Set<Uri> selected = new LinkedHashSet<>();
			ClipData clip = intent == null ? null : intent.getClipData();
			if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
				Uri uri = clip.getItemAt(i).getUri();
				if (uri == null) throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned an empty selection.");
				selected.add(uri);
				if (!request.multiple) break;
			}
			if (selected.isEmpty() && intent != null && intent.getData() != null) selected.add(intent.getData());
			if (selected.isEmpty()) {
				if ("photos".equals(request.source)) finishWithoutResources(request, new PluginResult(PluginResult.Status.OK, "RESULT_CANCELED"));
				else throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned no file URI.");
				return;
			}
			if (request.maxFiles > 0 && selected.size() > request.maxFiles) throw new ChooserError(ChooserError.Code.TOO_MANY_FILES, "Selection exceeds the file count limit.");
			List<Uri> uris = new ArrayList<>(selected);
			cordova.getThreadPool().execute(() -> read(request, uris));
		}
		catch (Exception error) { finishWithoutResources(request, failure(error, ChooserError.Code.READ_FAILED)); }
	}

	private void read(ChooserRequest request, List<Uri> uris) {
		boolean delivered = false;
		JSONObject failed = null;
		try {
			request.checkCanceled();
			if (request.mode == ChooserRequest.Mode.COPY) request.attach(ChooserTransaction.begin(cordova.getContext().getCacheDir()));
			ContentResolver resolver = cordova.getContext().getContentResolver();
			ChooserResources.Batch batch = new ChooserResources.Batch(request.budget);
			JSONArray results = new JSONArray();
			for (Uri uri : uris) {
				request.checkCanceled();
				if (!"content".equalsIgnoreCase(uri.getScheme())) throw new ChooserError(ChooserError.Code.READ_FAILED, "Expected a content URI from the provider.");
				JSONObject result = metadata(resolver, uri, request);
				if (request.mode == ChooserRequest.Mode.COPY) {
					File file = request.transaction().create();
					long size;
					try (InputStream input = open(resolver, uri, request.cancellation)) {
						request.attachInput(input);
						try (FileOutputStream output = new FileOutputStream(file)) {
							size = ChooserFiles.copy(input, output, request.budget, () -> request.canceled);
						}
						finally { request.detachInput(input); }
					}
					result.put("uri", Uri.fromFile(request.transaction().destination(file)).toString());
					result.put("id", file.getName());
					result.put("size", size);
				}
				else if (request.mode == ChooserRequest.Mode.DATA) {
					CancellationSignal signal = new CancellationSignal();
					String id = resources().register(new ChooserResources.SourceAccess() {
						public InputStream open() throws IOException { return Chooser.open(resolver, uri, signal); }
						public void cancel() { signal.cancel(); }
					}, batch);
					request.sources.add(id);
					result.put("id", id).put("kind", "source");
				}
				results.put(result);
			}
			request.checkCanceled();
			if (request.transaction() != null) request.transaction().commit(() -> request.canceled);
			delivered = finish(request, new PluginResult(PluginResult.Status.OK, request.multiple ? results.toString() : results.getJSONObject(0).toString()));
		}
		catch (OutOfMemoryError error) { failed = detail(ChooserError.Code.OUT_OF_MEMORY, "Insufficient memory for file selection."); }
		catch (Exception error) {
			failed = request.canceled ? cancellationDetail() : failureDetail(error, ChooserError.Code.READ_FAILED);
		}
		finally {
			if (!delivered) {
				// Freeze the operation failure before cleanup, which may itself fail or receive a late abort.
				JSONObject original = failed != null ? failed : request.canceled ? cancellationDetail() :
					detail(ChooserError.Code.READ_FAILED, "Selection could not be delivered.");
				JSONArray failures = rollback(request);
				if (failures.length() > 0) {
					JSONObject detail = detail(ChooserError.Code.CLEANUP_FAILED, "Selection cleanup failed; retry releasing the listed ids.");
					try {
						detail.put("outcome", new JSONObject().put("status", "rejected").put("reason", original));
						detail.put("failures", failures);
					}
					catch (JSONException impossible) { throw new IllegalStateException(impossible); }
					finishTerminal(request, new PluginResult(PluginResult.Status.ERROR, detail), true);
				}
				else if (request.canceled) finishCancellation(request);
				else if (failed != null) finish(request, new PluginResult(PluginResult.Status.ERROR, failed));
			}
			else request.finishResources(true);
		}
	}

	private JSONArray rollback(ChooserRequest request) {
		JSONArray failures = new JSONArray();
		for (String id : request.sources) {
			try { resources().release(id); }
			catch (Exception error) { failures.put(releaseFailure(id, error)); }
		}
		ChooserTransaction transaction = request.transaction();
		if (transaction != null) {
			try { transaction.finishChecked(false); }
			catch (IOException error) { for (String id : transaction.ids()) failures.put(releaseFailure(id, error)); }
		}
		return failures;
	}
	private static JSONObject releaseFailure(String id, Exception error) {
		try { return new JSONObject().put("id", id).put("error", detail(ChooserError.Code.RELEASE_FAILED, "Resource cleanup failed.")); }
		catch (JSONException impossible) { throw new IllegalStateException(impossible); }
	}

	private static InputStream open(ContentResolver resolver, Uri uri, CancellationSignal signal) throws IOException {
		signal.throwIfCanceled();
		AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r", signal);
		if (descriptor == null) throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned no stream.");
		try {
			InputStream input = descriptor.createInputStream();
			return new FilterInputStream(input) {
				private boolean closed;
				@Override public synchronized void close() throws IOException {
					if (!closed) {
						try { in.close(); } finally { descriptor.close(); }
						closed = true;
					}
				}
			};
		}
		catch (IOException | RuntimeException error) { descriptor.close(); throw error; }
	}
	private JSONObject metadata(ContentResolver resolver, Uri uri, ChooserRequest request) throws JSONException, IOException {
		request.checkCanceled();
		String name = "File";
		Object size = JSONObject.NULL;
		try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null, request.cancellation)) {
			if (cursor != null && cursor.moveToFirst()) {
				int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
				int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
				if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
					String display = cursor.getString(nameIndex);
					if (display != null && !display.isEmpty()) name = display;
				}
				if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
					long reported = cursor.getLong(sizeIndex);
					if (reported >= 0 && reported <= ChooserFiles.MAX_SAFE_INTEGER) size = reported;
				}
			}
		}
		catch (RuntimeException ignored) { /* Metadata is optional; cancellation is checked again below. */ }
		request.checkCanceled();
		String type = null;
		try { type = resolver.getType(uri); } catch (RuntimeException ignored) {}
		if (type == null || !type.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) {
			int dot = name.lastIndexOf('.');
			type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
		}
		return new JSONObject().put("name", name).put("mediaType", type == null ? "application/octet-stream" : type).put("sourceUri", uri.toString()).put("size", size);
	}

	private void finishWithoutResources(ChooserRequest request, PluginResult result) {
		synchronized (lock) {
			if (request.canceled) finishCancellation(request);
			else finish(request, result);
		}
	}

	private boolean finish(ChooserRequest request, PluginResult result) { return finishTerminal(request, result, false); }
	private boolean finishTerminal(ChooserRequest request, PluginResult result, boolean allowCanceled) {
		synchronized (lock) {
			if (active != request || !(request.canceled && allowCanceled ? request.completeCanceled() : request.complete())) return false;
			try { request.callback.sendPluginResult(result); return true; }
			finally { request.finish(); active = null; }
		}
	}
	private static JSONObject cancellationDetail() {
		return detail(ChooserError.Code.CANCELLED, "File selection was cancelled.");
	}
	private void finishCancellation(ChooserRequest request) {
		finishTerminal(request, new PluginResult(PluginResult.Status.ERROR, cancellationDetail()), true);
	}
	private static JSONObject detail(ChooserError.Code code, String message) {
		try {
			JSONObject result = new JSONObject().put("code", code.name()).put("message", message);
			if (code == ChooserError.Code.CANCELLED) result.put("reason", "signal");
			return result;
		}
		catch (JSONException impossible) { throw new IllegalStateException(impossible); }
	}
	private static PluginResult error(ChooserError.Code code, String message) { return new PluginResult(PluginResult.Status.ERROR, detail(code, message)); }
	private static PluginResult failure(Exception failure, ChooserError.Code fallback) {
		return new PluginResult(PluginResult.Status.ERROR, failureDetail(failure, fallback));
	}
	private static JSONObject failureDetail(Exception failure, ChooserError.Code fallback) {
		if (failure instanceof ChooserError) {
			ChooserError known = (ChooserError) failure;
			return detail(known.code, known.detail);
		}
		if (failure instanceof SecurityException) return detail(ChooserError.Code.PERMISSION_DENIED, "Provider denied file access.");
		return detail(fallback, fallback == ChooserError.Code.INVALID_ARGUMENT ? "Invalid chooser arguments." : "File operation failed.");
	}

	@Override
	public Bundle onSaveInstanceState() {
		synchronized (lock) {
			ChooserRequest request = pendingPicker != null ? pendingPicker : active;
			if (request == null || (pendingPicker == null && request.state() != ChooserRequest.State.SELECTING)) return null;
			Bundle state = new Bundle();
			state.putBoolean("abandoned", request.canceled || active != request);
			state.putString("requestId", request.requestId);
			state.putString("source", request.source);
			state.putStringArray("mediaTypes", request.mediaTypes);
			state.putString("accept", request.accept);
			state.putString("mode", request.mode.wire);
			state.putBoolean("multiple", request.multiple);
			state.putBoolean("localOnly", request.localOnly);
			state.putLong("limit", request.limit);
			state.putLong("maxFiles", request.maxFiles);
			state.putLong("maxTotalSize", request.maxTotalSize);
			state.putInt("code", request.code);
			return state;
		}
	}
	@Override
	public void onRestoreStateForActivityResult(Bundle state, CallbackContext callback) {
		ChooserRequest previous;
		synchronized (lock) {
			previous = active;
			active = null;
			pendingPicker = null;
			generation++;
			try {
				if (state == null) throw new IllegalArgumentException("Missing picker state.");
				int code = state.getInt("code", 1001);
				String accept = state.getString("accept", "*/*");
				String source = state.getString("source", "documents");
				String requestId = state.getString("requestId");
				String[] mediaTypes = state.getStringArray("mediaTypes");
				if (code < 1000 || code > 32767 || accept == null || requestId == null || requestId.isEmpty() || mediaTypes == null || !("photos".equals(source) || "documents".equals(source))) throw new IllegalArgumentException("Invalid picker state.");
				JSONObject validate = new JSONObject().put("mediaTypes", new JSONArray(mediaTypes));
				mediaTypes = photoTypes(validate, source);
				active = new ChooserRequest(callback, accept, ChooserRequest.Mode.parse(state.getString("mode", "metadata")), state.getBoolean("multiple"), state.getBoolean("localOnly"), restoredLimit(state, "limit"), restoredLimit(state, "maxFiles"), restoredLimit(state, "maxTotalSize"), code, requestId, source, mediaTypes);
				pendingPicker = active;
				active.restoredAbandoned = state.getBoolean("abandoned");
				if (active.restoredAbandoned) active.canceled = true;
				nextRequestCode = code;
			}
			catch (Exception error) { callback.sendPluginResult(error(ChooserError.Code.READ_INTERRUPTED, "Picker state could not be restored.")); }
		}
		if (previous != null) CLEANUP.execute(() -> { try { previous.cancel(); } catch (RuntimeException ignored) {} });
	}
	private static long restoredLimit(Bundle state, String name) {
		long value = state.getLong(name);
		if (value < 0 || value > ChooserFiles.MAX_SAFE_INTEGER) throw new IllegalArgumentException("Invalid saved limit.");
		return value;
	}
	@Override
	public void onReset() {
		ChooserRequest previous;
		ChooserResources owned;
		synchronized (lock) {
			generation++;
			previous = active;
			active = null;
			if (previous != null) previous.canceled = true;
			owned = resources;
		}
		if (previous != null) CLEANUP.execute(() -> { try { previous.cancel(); } catch (RuntimeException ignored) {} });
		if (owned != null) for (String id : owned.sources()) CLEANUP.execute(() -> {
			try { owned.release(id); } catch (IOException ignored) { /* Explicit release can retry. */ }
		});
	}
	@Override public void onDestroy() { onReset(); }
}
