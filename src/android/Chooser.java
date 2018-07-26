package com.cyph.cordova;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaArgs;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONException;
import org.json.JSONObject;


public class Chooser extends CordovaPlugin {
	private static final String ACTION_OPEN = "getFile";
	private static final int PICK_FILE_REQUEST = 1;
	private static final String TAG = "Chooser";

	/** @see https://stackoverflow.com/a/17861016/459881 */
	public static byte[] getBytesFromInputStream (InputStream is) throws IOException {
		ByteArrayOutputStream os = new ByteArrayOutputStream();
		byte[] buffer = new byte[0xFFFF];

		for (int len = is.read(buffer); len != -1; len = is.read(buffer)) {
			os.write(buffer, 0, len);
		}

		return os.toByteArray();
	}

	/** @see https://stackoverflow.com/a/23270545/459881 */
	public static String getDisplayName (ContentResolver contentResolver, Uri uri) {
		String[] projection = {MediaStore.MediaColumns.DISPLAY_NAME};
		Cursor metaCursor = contentResolver.query(uri, projection, null, null, null);

		if (metaCursor != null) {
			try {
				if (metaCursor.moveToFirst()) {
					return metaCursor.getString(0);
				}
			} finally {
				metaCursor.close();
			}
		}

		return "File";
	}


	private CallbackContext callback;

	public void chooseFile (CallbackContext callbackContext, String accept) {
		Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
		intent.setType(accept);
		intent.addCategory(Intent.CATEGORY_OPENABLE);
		intent.putExtra(Intent.EXTRA_LOCAL_ONLY, true);

		Intent chooser = Intent.createChooser(intent, "Select File");
		cordova.startActivityForResult(this, chooser, Chooser.PICK_FILE_REQUEST);

		PluginResult pluginResult = new PluginResult(PluginResult.Status.NO_RESULT);
		pluginResult.setKeepCallback(true);
		this.callback = callbackContext;
		callbackContext.sendPluginResult(pluginResult);
	}

	@Override
	public boolean execute (
		String action,
		CordovaArgs args,
		CallbackContext callbackContext
	) throws JSONException {
		if (action.equals(Chooser.ACTION_OPEN)) {
			String accept = args.optString(0);
			if (accept == "" || accept == null) {
				accept = "*/*";
			}

			this.chooseFile(callbackContext, accept);
			return true;
		}

		return false;
	}

	@Override
	public void onActivityResult (int requestCode, int resultCode, Intent data) {
		try {
			if (requestCode == Chooser.PICK_FILE_REQUEST && this.callback != null) {
				if (resultCode == Activity.RESULT_OK) {
					Uri uri = data.getData();

					if (uri != null) {
						ContentResolver contentResolver =
							this.cordova.getActivity().getContentResolver()
						;

						String name = Chooser.getDisplayName(contentResolver, uri);

						String mediaType = contentResolver.getType(uri);
						if (mediaType == null || mediaType == "") {
							mediaType = "application/octet-stream";
						}

						byte[] bytes = Chooser.getBytesFromInputStream(
							contentResolver.openInputStream(uri)
						);

						String base64 = Base64.encodeToString(bytes, Base64.DEFAULT);

						JSONObject result = new JSONObject();

						result.put("data", base64);
						result.put("mediaType", mediaType);
						result.put("name", name);
						result.put("uri", uri.toString());

						this.callback.success(result.toString());
					}
					else {
						this.callback.error("File URI was null.");
					}
				}
				else if (resultCode == Activity.RESULT_CANCELED) {
					PluginResult pluginResult = new PluginResult(PluginResult.Status.NO_RESULT);
					this.callback.sendPluginResult(pluginResult);
				}
				else {
					this.callback.error(resultCode);
				}
			}
		}
		catch (IOException|JSONException err) {
			this.callback.error("Failed to read file.");
		}
	}
}
