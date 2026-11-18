package com.cyph.cordova;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import java.util.concurrent.Executor;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONObject;

public class Chooser extends CordovaPlugin {
	private final ChooserEngine engine = new ChooserEngine(new ChooserEngine.Host() {
		public Context context() { return cordova.getContext(); }
		public Activity activity() { return cordova.getActivity(); }
		public Executor pickerWorker() { return cordova.getThreadPool(); }
		public void launch(Intent intent, ChooserRequest request) {
			cordova.startActivityForResult(Chooser.this, intent, request.code);
		}
	}, 0);

	private static ChooserEngine.Reply reply(CallbackContext callback) {
		return new ChooserEngine.Reply() {
			public void pending() {
				PluginResult result = new PluginResult(PluginResult.Status.NO_RESULT);
				result.setKeepCallback(true);
				callback.sendPluginResult(result);
			}
			public void send(ChooserEngine.Response result) {
				if (result.error != null) callback.error(result.error);
				else if (result.value instanceof String) callback.success((String) result.value);
				else if (result.value instanceof JSONObject) callback.success((JSONObject) result.value);
				else callback.success();
			}
		};
	}

	@Override public boolean execute(String action, JSONArray args, CallbackContext callback) {
		return engine.execute(action, args, reply(callback));
	}

	Intent pickerIntent(ChooserRequest request) { return engine.pickerIntent(request); }
	@Override public void onActivityResult(int code, int result, Intent data) { engine.onActivityResult(code, result, data); }
	@Override public Bundle onSaveInstanceState() { return engine.onSaveInstanceState(); }
	@Override public void onRestoreStateForActivityResult(Bundle state, CallbackContext callback) {
		engine.onRestoreStateForActivityResult(state, reply(callback));
	}
	@Override public void onReset() { engine.onReset(); }
	@Override public void onDestroy() { onReset(); }
}
