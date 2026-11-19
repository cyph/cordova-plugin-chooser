package com.cyph.cordova;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;

@CapacitorPlugin(name = "Chooser", requestCodes = {CapacitorChooser.PICKER_REQUEST_CODE})
@SuppressWarnings("deprecation")
public final class CapacitorChooser extends Plugin {
	static final int PICKER_REQUEST_CODE = 0x4358;
	private static final Executor PICKER_WORKER = Executors.newCachedThreadPool();
	private volatile boolean awaitingRestoredResult;

	private final ChooserEngine engine = new ChooserEngine(new ChooserEngine.Host() {
		public Context context() { return getContext(); }
		public Activity activity() { return getActivity(); }
		public Executor pickerWorker() { return PICKER_WORKER; }
		public void launch(Intent intent, ChooserRequest request) {
			// An explicit request code allows AbortSignal to dismiss the activity.
			PluginCall call = ((Reply) request.callback).call;
			startActivityForResult(call, intent, request.code);
		}
	}, PICKER_REQUEST_CODE);

	private static final class Reply implements ChooserEngine.Reply {
		private final PluginCall call;
		Reply(PluginCall call) { this.call = call; }
		public void send(ChooserEngine.Response result) {
			if (result.error == null) {
				call.resolve(new JSObject().put("value", result.value));
				return;
			}
			try {
				JSObject details = JSObject.fromJSONObject(result.error);
				call.reject(details.optString("message"), details.optString("code"), details);
			}
			catch (JSONException error) { call.reject("Invalid chooser error.", "READ_FAILED"); }
		}
	}

	private void dispatch(String action, PluginCall call) {
		JSONArray args = call.getData().optJSONArray("args");
		engine.execute(action, args == null ? new JSONArray() : args, new Reply(call));
	}

	@PluginMethod public void pick(PluginCall call) {
		if (awaitingRestoredResult) {
			call.reject("The previous file picker is still active.", "BUSY");
			return;
		}
		dispatch("pick", call);
	}
	@PluginMethod public void cancelPick(PluginCall call) { dispatch("cancelPick", call); }
	@PluginMethod public void readFile(PluginCall call) { dispatch("readFile", call); }
	@PluginMethod public void cancelRead(PluginCall call) { dispatch("cancelRead", call); }
	@PluginMethod public void statFile(PluginCall call) { dispatch("statFile", call); }
	@PluginMethod public void releaseFile(PluginCall call) { dispatch("releaseFile", call); }

	@Override protected Bundle saveInstanceState() {
		// Capacitor persists the pending PluginCall only when this returns a bundle.
		return awaitingRestoredResult ? new Bundle() : engine.onSaveInstanceState();
	}
	@Override protected void restoreState(Bundle state) { awaitingRestoredResult = true; }

	@Override protected void handleOnActivityResult(int code, int status, Intent data) {
		if (code != PICKER_REQUEST_CODE) return;
		if (awaitingRestoredResult) {
			awaitingRestoredResult = false;
			// The destroyed WebView can no longer consume the selection. Do not open
			// provider streams or allocate cache files for a result nobody owns.
			PluginCall call = getSavedCall();
			if (call != null) call.reject("The app was recreated during selection. Pick the file again.", "READ_INTERRUPTED");
		}
		else engine.onActivityResult(code, status, data);
		// The bridge may have restored its last call into the legacy slot.
		saveCall(null);
	}


	@Override public void removeAllListeners() {
		// Capacitor clears bridge listeners when the WebView navigates.
		super.removeAllListeners();
		engine.onReset();
	}

	@Override protected void handleOnDestroy() { engine.onReset(); }
}
