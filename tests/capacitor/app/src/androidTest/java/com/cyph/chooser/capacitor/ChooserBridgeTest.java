package com.cyph.chooser.capacitor;

import static org.junit.Assert.*;
import static androidx.test.espresso.intent.Intents.intending;
import static androidx.test.espresso.intent.matcher.IntentMatchers.hasAction;
import android.app.Activity;
import android.app.Instrumentation.ActivityResult;
import android.content.Intent;
import android.net.Uri;
import androidx.test.core.app.ActivityScenario;
import androidx.test.espresso.intent.Intents;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(AndroidJUnit4.class)
public final class ChooserBridgeTest {
    private ActivityScenario<MainActivity> scenario;
    private String evaluate(String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, result -> {
            value.set(result); completed.countDown();
        }));
        assertTrue("JavaScript evaluation timed out", completed.await(10, TimeUnit.SECONDS));
        return value.get();
    }
    private String awaitValue(String script) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
        while (System.nanoTime() < end) {
            String value = evaluate(script);
            if (!"null".equals(value)) return new org.json.JSONTokener(value).nextValue().toString();
            Thread.sleep(50);
        }
        throw new AssertionError("Bridge result timed out");
    }
    private JSONObject result(String expression) throws Exception {
        evaluate("window.outcome = null; Promise.resolve().then(() => " + expression +
            ").then(value => window.outcome = JSON.stringify({ok:true,value:value===undefined?null:value})," +
            "error => window.outcome = JSON.stringify({ok:false,error:String(error)}));");
        return new JSONObject(awaitValue("window.outcome"));
    }
    private void select() {
        intending(hasAction(Intent.ACTION_CHOOSER)).respondWith(new ActivityResult(Activity.RESULT_OK,
            new Intent().setData(FixtureProvider.URI).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)));
    }
    private static byte[] hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        try (FileInputStream input = new FileInputStream(file)) {
            for (int count; (count = input.read(buffer)) != -1;) digest.update(buffer, 0, count);
        }
        return digest.digest();
    }
    @Test public void realBridgeCopiesLargeFilesAndEnforcesLimits() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(33, android.os.Build.VERSION.SDK_INT);
        File source = FixtureProvider.source(context);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            scenario = activity;
            awaitValue("window.chooser && window.fixtureReady ? 'ready' : null");
            System.out.println("WebView: " + evaluate("navigator.userAgent"));
            Intents.init();
            try {
                select();
                for (int mib : new int[]{45, 128}) {
                    byte[] block = new byte[64 * 1024];
                    for (int i = 0; i < block.length; i++) block[i] = (byte)(i * 31 + 7);
                    try (FileOutputStream output = new FileOutputStream(source)) {
                        for (int i = 0; i < mib * 16; i++) output.write(block);
                    }
                    long size = source.length();
                    FixtureProvider.reportedSize = 1; // Count bytes, not inaccurate metadata.
                    JSONObject response = result("chooser.getFileUri({maxFileSize:" + size + "})");
                    assertTrue(response.toString(), response.getBoolean("ok"));
                    assertTrue(response.toString().length() < 16 * 1024);
                    JSONObject file = response.getJSONObject("value");
                    assertFalse(file.has("data"));
                    assertFalse(file.has("dataURI"));
                    assertEquals(size, file.getLong("size"));
                    File copy = new File(Uri.parse(file.getString("uri")).getPath());
                    assertArrayEquals(hash(source), hash(copy));
                    assertTrue(result("chooser.releaseFile(" + JSONObject.quote(file.getString("id")) + ")").getBoolean("ok"));
                    assertFalse(copy.exists());
                    assertEquals(size, source.length());
                    JSONObject failure = result("chooser.getFileUri({maxFileSize:" + (size - 1) + "})");
                    assertFalse(failure.getBoolean("ok"));
                    assertTrue(failure.getString("error").contains("FILE_TOO_LARGE"));
                    File cache = new File(context.getCacheDir(), "cordova-plugin-chooser");
                    File[] remaining = cache.listFiles(fileInCache -> !fileInCache.getName().equals(".pending"));
                    assertNotNull(remaining);
                    assertEquals(0, remaining.length);
                }
            } finally { Intents.release(); }
        } finally { source.delete(); }
    }
    @Test public void cancellationSettlesOnceAndCanImmediatelyReopen() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            scenario = activity;
            awaitValue("window.chooser && window.fixtureReady ? 'ready' : null");
            Intents.init();
            try {
                intending(hasAction(Intent.ACTION_CHOOSER)).respondWith(new ActivityResult(Activity.RESULT_CANCELED, null));
                for (int i = 0; i < 3; i++) {
                    JSONObject response = result("chooser.getFileUri()");
                    assertTrue(response.toString(), response.getBoolean("ok"));
                    assertTrue(response.isNull("value"));
                }
            } finally { Intents.release(); }
        }
    }
    @Test public void unknownLengthPdfPipesPreserveBytes() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        byte[] pdf = new byte[]{37, 80, 68, 70, 45, 49, 46, 52, 10, 0, (byte)255};
        File source = FixtureProvider.source(context);
        try (FileOutputStream output = new FileOutputStream(source)) { output.write(pdf); }
        FixtureProvider.pipe = true;
        FixtureProvider.reportedSize = -1;
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            scenario = activity;
            awaitValue("window.chooser && window.fixtureReady ? 'ready' : null");
            Intents.init();
            try {
                select();
                JSONObject data = result("chooser.getFile('application/pdf').then(file => ({bytes:Array.from(file.data),dataURI:file.dataURI}))");
                assertTrue(data.toString(), data.getBoolean("ok"));
                org.json.JSONArray bytes = data.getJSONObject("value").getJSONArray("bytes");
                assertEquals(pdf.length, bytes.length());
                for (int i = 0; i < pdf.length; i++) assertEquals(pdf[i] & 255, bytes.getInt(i));
                JSONObject copied = result("chooser.getFileUri({maxFileSize:11})");
                assertTrue(copied.toString(), copied.getBoolean("ok"));
                JSONObject reference = copied.getJSONObject("value");
                assertEquals(pdf.length, reference.getLong("size"));
                assertArrayEquals(hash(source), hash(new File(Uri.parse(reference.getString("uri")).getPath())));
                assertTrue(result("chooser.releaseFile(" + JSONObject.quote(reference.getString("id")) + ")").getBoolean("ok"));
            } finally { Intents.release(); }
        } finally { FixtureProvider.pipe = false; source.delete(); }
    }
}
