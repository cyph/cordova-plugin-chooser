package com.cyph.chooser.capacitor;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

// A deterministic provider, never a replacement for the native Chooser plugin.
public final class FixtureProvider extends ContentProvider {
    static final Uri URI = Uri.parse("content://com.cyph.chooser.capacitor.documents/source");
    static volatile long reportedSize = -1;
    static File source(android.content.Context context) { return new File(context.getFilesDir(), "original.bin"); }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String sort) {
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{"../fixture.exe", reportedSize < 0 ? null : reportedSize});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) || !URI.equals(uri)) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(source(getContext()), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
