package com.cyph.cordova;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Base64OutputStream;
import android.webkit.MimeTypeMap;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class Chooser extends CordovaPlugin {
	private final Object lock = new Object();
	private ChooserRequest active;
	private int nextRequestCode = 1000;
	private long generation;


	@Override
	public boolean execute(String action, JSONArray args, CallbackContext callback) {
		if ("releaseFile".equals(action)) {
			try {
				final String id = args.getString(0);
				final long owner;
				synchronized (lock) { owner = generation; }
				ChooserTransaction.HOUSEKEEPING.execute(() -> {
					PluginResult result;
					try {
						ChooserFiles.release(cordova.getContext().getCacheDir(), id);
						result = new PluginResult(PluginResult.Status.OK);
					}
					catch (Exception error) {
						result = new PluginResult(PluginResult.Status.ERROR, message(error));
					}
					synchronized (lock) {
						if (generation == owner) { callback.sendPluginResult(result); }
					}
				});
			}
			catch (Exception error) {
				callback.error(ChooserError.message(ChooserError.Code.INVALID_ARGUMENT, "Expected a managed file id."));
			}
			return true;
		}
		if (!"getFile".equals(action) && !"pick".equals(action)) {
			return false;
		}
		try {
			String accept;
			ChooserRequest.Mode mode;
			boolean multiple = false;
			boolean localOnly = true;
			long limit = 0;
			if ("getFile".equals(action)) {
				if (!(args.get(0) instanceof String) || !(args.get(1) instanceof Boolean)) {
					throw new JSONException("Expected a MIME filter and includeData boolean.");
				}
				accept = args.getString(0);
				mode = args.getBoolean(1) ? ChooserRequest.Mode.DATA : ChooserRequest.Mode.METADATA;
			}
			else {
				JSONObject options = args.getJSONObject(0);
				if (!(options.get("accept") instanceof String) || !(options.get("mode") instanceof String) ||
					!(options.get("multiple") instanceof Boolean) || !(options.get("localOnly") instanceof Boolean)) {
					throw new JSONException("Invalid picker option types.");
				}
				accept = options.getString("accept");
				mode = ChooserRequest.Mode.parse(options.getString("mode"));
				multiple = options.getBoolean("multiple");
				localOnly = options.getBoolean("localOnly");
				Object value = options.get("maxFileSize");
				if (!(value instanceof Number)) {
					throw new JSONException("Expected a numeric byte limit.");
				}
				double numeric = ((Number) value).doubleValue();
				if (!Double.isFinite(numeric) || numeric < 0 || numeric > ChooserFiles.MAX_SAFE_INTEGER || numeric != Math.floor(numeric)) {
					throw new JSONException("Invalid byte limit.");
				}
				limit = (long) numeric;
			}
			accept = accept.toLowerCase(Locale.ROOT).replaceAll("\\s", "");
			if (accept.isEmpty()) {
				accept = "*/*";
			}
			final ChooserRequest request;
			synchronized (lock) {
				if (active != null) {
					callback.error(ChooserError.message(ChooserError.Code.BUSY, "A file picker is already active."));
					return true;
				}
				nextRequestCode = nextRequestCode == 32767 ? 1000 : nextRequestCode + 1;
				request = new ChooserRequest(callback, accept, mode, multiple, localOnly, limit, nextRequestCode);
				active = request;
				PluginResult pending = new PluginResult(PluginResult.Status.NO_RESULT);
				pending.setKeepCallback(true);
				callback.sendPluginResult(pending);
			}
			try {
				cordova.getActivity().runOnUiThread(() -> launch(request));
			}
			catch (Exception error) {
				finish(request, new PluginResult(PluginResult.Status.ERROR, ChooserError.message(ChooserError.Code.PICKER_FAILED, "") + message(error)));
			}
		}
		catch (Exception error) {
			callback.error(ChooserError.message(ChooserError.Code.INVALID_ARGUMENT, "") + message(error));
		}
		return true;
	}

	private void launch(ChooserRequest request) {
		synchronized (lock) {
			if (active != request || request.canceled) {
				return;
			}
			try {
				Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
				String[] types = request.accept.split(",");
				intent.setType(types.length == 1 ? types[0] : "*/*");
				if (types.length > 1) {
					intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
				}
				intent.addCategory(Intent.CATEGORY_OPENABLE);
				intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, request.multiple);
				intent.putExtra(Intent.EXTRA_LOCAL_ONLY, request.localOnly);
				intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
				cordova.startActivityForResult(this, Intent.createChooser(intent, "Select File"), request.code);
			}
			catch (Exception error) {
				finish(request, new PluginResult(PluginResult.Status.ERROR, ChooserError.message(ChooserError.Code.PICKER_FAILED, "") + message(error)));
			}
		}
	}

	@Override
	public void onActivityResult(int requestCode, int resultCode, Intent intent) {
		final ChooserRequest request;
		synchronized (lock) {
			request = active;
			if (request == null || request.code != requestCode || !request.process()) {
				return;
			}
		}
		if (resultCode == Activity.RESULT_CANCELED) {
			finish(request, new PluginResult(PluginResult.Status.OK, "RESULT_CANCELED"));
			return;
		}
		if (resultCode != Activity.RESULT_OK) {
			finish(request, new PluginResult(PluginResult.Status.ERROR, ChooserError.message(ChooserError.Code.PICKER_FAILED, "Unexpected activity result ") + resultCode));
			return;
		}
		try {
			// Preserve provider order, tolerate the single-selection fallback, and deduplicate.
			Set<Uri> selected = new LinkedHashSet<>();
			ClipData clip = intent == null ? null : intent.getClipData();
			if (clip != null) {
				for (int i = 0; i < clip.getItemCount(); i++) {
					Uri uri = clip.getItemAt(i).getUri();
					if (uri == null) {
						throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned an empty selection.");
					}
					selected.add(uri);
					if (!request.multiple) {
						break;
					}
				}
			}
			if (selected.isEmpty() && intent != null && intent.getData() != null) {
				selected.add(intent.getData());
			}
			if (selected.isEmpty()) {
				throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned no file URI.");
			}
			List<Uri> uris = new ArrayList<>(selected);
			cordova.getThreadPool().execute(() -> read(request, uris));
		}
		catch (Exception error) {
			finish(request, new PluginResult(PluginResult.Status.ERROR, message(error)));
		}
	}

	private void read(ChooserRequest request, List<Uri> uris) {
		boolean delivered = false;
		try {
			request.checkCanceled();
			if (request.mode == ChooserRequest.Mode.COPY) request.attach(ChooserTransaction.begin(cordova.getContext().getCacheDir()));
			ContentResolver resolver = cordova.getContext().getContentResolver();
			JSONArray results = new JSONArray();
			for (Uri uri : uris) {
				if (request.canceled) {
					throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Request was reset.");
				}
				// Current Android document providers use content URIs, not arbitrary private paths.
				if (!"content".equalsIgnoreCase(uri.getScheme())) {
					throw new ChooserError(ChooserError.Code.READ_FAILED, "Expected a content URI from the document provider.");
				}
				JSONObject result = metadata(resolver, uri, request);
				if (request.mode == ChooserRequest.Mode.COPY) {
					File file = request.transaction().create();
					long size;
					try (AssetFileDescriptor descriptor = open(resolver, uri, request);
						 InputStream input = descriptor.createInputStream();
						 FileOutputStream output = new FileOutputStream(file)) {
						size = ChooserFiles.copy(input, output, request.limit, () -> request.canceled);
					}
					result.put("sourceUri", uri.toString());
					result.put("uri", Uri.fromFile(request.transaction().destination(file)).toString());
					result.put("id", file.getName());
					result.put("size", size);
				}
				else if (request.mode == ChooserRequest.Mode.DATA) {
					// Encode one continuous stream so padding only occurs at EOF.
					ByteArrayOutputStream encoded = new ByteArrayOutputStream();
					long size;
					try (AssetFileDescriptor descriptor = open(resolver, uri, request);
						 InputStream input = descriptor.createInputStream();
						 Base64OutputStream output = new Base64OutputStream(encoded, Base64.NO_WRAP)) {
						size = ChooserFiles.copy(input, output, 0, () -> request.canceled);
					}
					result.put("data", encoded.toString("US-ASCII"));
					result.put("size", size);
				}
				results.put(result);
			}
			request.checkCanceled();
			if (request.transaction() != null) request.transaction().commit();
			String json = request.multiple ? results.toString() : results.getJSONObject(0).toString();
			delivered = finish(request, new PluginResult(PluginResult.Status.OK, json));
		}
		catch (OutOfMemoryError error) {
			finish(request, new PluginResult(PluginResult.Status.ERROR, ChooserError.message(ChooserError.Code.OUT_OF_MEMORY, "Use getFileUri() for large files.")));
		}
		catch (Exception error) {
			finish(request, new PluginResult(PluginResult.Status.ERROR, message(error)));
		}
		finally {
			request.finishResources(delivered);
		}
	}

	private AssetFileDescriptor open(ContentResolver resolver, Uri uri, ChooserRequest request) throws IOException {
		request.checkCanceled();
		AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r", request.cancellation);
		if (descriptor == null) throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned no stream.");
		return descriptor;
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
					if (display != null && !display.isEmpty()) {
						name = display;
					}
				}
				if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
					long reported = cursor.getLong(sizeIndex);
					if (reported >= 0 && reported <= ChooserFiles.MAX_SAFE_INTEGER) {
						size = reported;
					}
				}
			}
		}
		catch (RuntimeException ignored) {
			// Optional provider metadata may be absent, unsupported, or unavailable offline.
		}
		request.checkCanceled();
		String type = null;
		try {
			type = resolver.getType(uri);
		}
		catch (RuntimeException ignored) {}
		if (type == null || !type.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) {
			int dot = name.lastIndexOf('.');
			type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
		}
		JSONObject result = new JSONObject();
		result.put("name", name);
		result.put("mediaType", type == null ? "application/octet-stream" : type);
		result.put("uri", uri.toString());
		result.put("size", size);
		return result;
	}

	private boolean finish(ChooserRequest request, PluginResult result) {
		synchronized (lock) {
			if (active != request || !request.complete()) {
				return false;
			}
			try {
				request.callback.sendPluginResult(result);
				return true;
			}
			finally {
				request.finish();
				active = null;
			}
		}
	}

	private static String message(Exception error) {
		return error.getMessage() == null ? ChooserError.message(ChooserError.Code.READ_FAILED, "File operation failed.") : error.getMessage();
	}

	@Override
	public Bundle onSaveInstanceState() {
		synchronized (lock) {
			if (active == null || active.canceled) {
				return null;
			}
			Bundle state = new Bundle();
			state.putString("accept", active.accept);
			state.putString("mode", active.mode.wire);
			state.putBoolean("multiple", active.multiple);
			state.putBoolean("localOnly", active.localOnly);
			state.putLong("limit", active.limit);
			state.putInt("code", active.code);
			return state;
		}
	}

	@Override
	public void onRestoreStateForActivityResult(Bundle state, CallbackContext callback) {
		if (state == null) {
			callback.error(ChooserError.message(ChooserError.Code.READ_INTERRUPTED, "Missing picker state."));
			return;
		}
		ChooserRequest previous;
		synchronized (lock) {
			previous = active;
			nextRequestCode = state.getInt("code", 1001);
			active = new ChooserRequest(callback, state.getString("accept", "*/*"), ChooserRequest.Mode.parse(state.getString("mode", "metadata")),
				state.getBoolean("multiple"), state.getBoolean("localOnly"), state.getLong("limit"), nextRequestCode);
		}
		if (previous != null) previous.cancel();
	}

	@Override
	public void onReset() {
		ChooserRequest previous;
		synchronized (lock) {
			generation++;
			previous = active;
			active = null;
		}
		if (previous != null) previous.cancel();
	}

	@Override
	public void onDestroy() {
		onReset();
	}
}
