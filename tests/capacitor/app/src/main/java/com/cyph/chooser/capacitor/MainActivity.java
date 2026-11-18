package com.cyph.chooser.capacitor;

import android.content.Intent;
import android.os.Bundle;

public final class MainActivity extends com.getcapacitor.BridgeActivity {
    volatile boolean holdPicker;
    volatile int heldRequestCode;

    @Override public void startActivityForResult(Intent intent, int requestCode, Bundle options) {
        if (holdPicker && Intent.ACTION_CHOOSER.equals(intent.getAction())) {
            heldRequestCode = requestCode;
            return;
        }
        super.startActivityForResult(intent, requestCode, options);
    }

    void deliverResult(int requestCode, int status, Intent data) {
        onActivityResult(requestCode, status, data);
    }
}
