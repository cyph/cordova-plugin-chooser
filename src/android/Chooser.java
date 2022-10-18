package com.cyph.cordova;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class Chooser extends CordovaPlugin {
    private static final String ACTION_OPEN = "getFile";
    private static final int PICK_FILE_REQUEST = 1;
    private static final String TAG = "Chooser";

    private CallbackContext callback;
    private int maxFileSize = 0;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
        try {
            if (action.equals(Chooser.ACTION_OPEN)) {
                this.chooseFile(callbackContext, args);
                return true;
            }
        } catch (JSONException err) {
            this.callback.error("Execute failed: " + err.toString());
        }

        return false;
    }

    public void chooseFile(CallbackContext callbackContext, JSONArray args) throws JSONException {
        JSONObject options = args.optJSONObject(0);
        String mimeTypes = options.optString("mimeTypes");
        int maxFileSize = options.optInt("maxFileSize");

        if (maxFileSize != 0) {
            this.maxFileSize = maxFileSize;
        }

        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        if (!mimeTypes.equals("*/*")) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.split(","));
        }
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        intent.putExtra(Intent.EXTRA_LOCAL_ONLY, true);

        Intent chooser = Intent.createChooser(intent, "Select File");
        cordova.startActivityForResult(this, chooser, Chooser.PICK_FILE_REQUEST);

        PluginResult pluginResult = new PluginResult(PluginResult.Status.NO_RESULT);
        pluginResult.setKeepCallback(true);
        this.callback = callbackContext;
        callbackContext.sendPluginResult(pluginResult);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        try {
            if (requestCode == Chooser.PICK_FILE_REQUEST && this.callback != null) {
                if (resultCode == Activity.RESULT_OK) {
                    Uri uri = data.getData();
                    if (uri != null) {
                        Activity activity = cordova.getActivity();
                        ContentResolver contentResolver = activity.getContentResolver();
                        InputStream inputStream = contentResolver.openInputStream(uri);
                        String displayName = "File";
                        String uriString = uri.toString();
                        String mimeType = null;
                        String extension = null;
                        String filePath = null;

                        int size = inputStream.available();
                        if (this.maxFileSize != 0) {
                            if (size > this.maxFileSize) {
                                this.callback.error("Invalid size");
                                return;
                            }
                        }

                        if (uriString.startsWith("content://")) {
                            Cursor cursor = null;
                            try {
                                cursor = contentResolver.query(uri, null, null, null, null);
                                if (cursor != null && cursor.moveToFirst()) {
                                    displayName = cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME));
                                }
                                mimeType = contentResolver.getType(uri);
                            } finally {
                                assert cursor != null;
                                cursor.close();
                            }
                        } else if (uriString.startsWith("file://")) {
                            displayName = new File(uriString).getName();
                            String[] parts = uriString.split("\\.");
                            String ext = parts[parts.length - 1];
                            if (ext != null) {
                                MimeTypeMap mime = MimeTypeMap.getSingleton();
                                mimeType = mime.getMimeTypeFromExtension(ext);
                            }
                        }

                        if (mimeType != null) {
                            MimeTypeMap mime = MimeTypeMap.getSingleton();
                            extension = mime.getExtensionFromMimeType(mimeType);
                        }

                        if (mimeType == null || mimeType.isEmpty()) {
                            mimeType = "application/octet-stream";
                        }

                        filePath = activity.getCacheDir().getAbsolutePath() + '/' + displayName;
                        copyInputStreamToFile(inputStream, filePath);

                        try {
                            JSONObject result = new JSONObject();
                            result.put("path", new File(filePath).exists() ? "file://" + filePath : "");
                            result.put("name",  this.getFileName(displayName)); // without extension
                            result.put("displayName",  displayName); // with extension
                            result.put("mimeType", mimeType);
                            result.put("extension", extension);
                            result.put("size", size);

                            this.callback.success(result);
                        } catch (JSONException e) {
                            this.callback.error("JSON Object not supported");
                        }

                    } else {
                        this.callback.error("File URI was null.");
                    }
                } else if (resultCode == Activity.RESULT_CANCELED) {
                    this.callback.success("RESULT_CANCELED");
                } else {
                    this.callback.error(resultCode);
                }
            }
        } catch (Exception err) {
            this.callback.error("Failed to read file: " + err.toString());
        }
    }

    private void copyInputStreamToFile(InputStream inputStream, String file) {
        OutputStream out = null;

        try {
            out = new FileOutputStream(file);
            byte[] buf = new byte[1024];
            int len;
            while ((len = inputStream.read(buf)) > 0) {
                out.write(buf, 0, len);
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            // Ensure that the InputStreams are closed even if there's an exception.
            try {
                if (out != null) {
                    out.close();
                }

                // If you want to close the "in" InputStream yourself then remove this
                // from here but ensure that you close it yourself eventually.
                inputStream.close();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
    }

    public String getFileName(String fileName) {
        if(!fileName.contains(".")){
            return fileName;
        }
        return fileName.substring(0,fileName.lastIndexOf("."));
    }

}
