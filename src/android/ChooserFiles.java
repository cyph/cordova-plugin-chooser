package com.cyph.cordova;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/** Filesystem operations shared by the plugin and host-side regression fixtures. */
final class ChooserFiles {
	static final long MAX_SAFE_INTEGER = 9007199254740991L;
	private static final Pattern ID = Pattern.compile(
		"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
	);

	private ChooserFiles() {}

	static boolean isId(String id) { return id != null && ID.matcher(id).matches(); }

	static long copy(InputStream input, OutputStream output, long limit, BooleanSupplier canceled) throws IOException {
		return copy(input, output, new ChooserBudget(limit, 0), canceled);
	}

	static long copy(InputStream input, OutputStream output, ChooserBudget budget, BooleanSupplier canceled) throws IOException {
		if (input == null) {
			throw new ChooserError(ChooserError.Code.READ_FAILED, "Provider returned no stream.");
		}
		byte[] buffer = new byte[64 * 1024];
		long total = 0;
		while (true) {
			if (canceled.getAsBoolean()) {
				throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Request was reset.");
			}
			int count = input.read(buffer);
			if (count == -1) {
				return total;
			}
			if (count == 0) {
				int next = input.read();
				if (next == -1) {
					return total;
				}
				buffer[0] = (byte) next;
				count = 1;
			}
			if (canceled.getAsBoolean()) {
				throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Request was reset.");
			}
			budget.consume(total, count);
			output.write(buffer, 0, count);
			total += count;
		}
	}

	static File directory(File cache) throws IOException {
		File root = new File(cache.getCanonicalFile(), "cordova-plugin-chooser");
		if (!root.getCanonicalFile().equals(root.getAbsoluteFile())) {
			throw new ChooserError(ChooserError.Code.CACHE_FAILED, "Cache directory must not be a symbolic link.");
		}
		if (!root.isDirectory() && !root.mkdirs()) {
			throw new ChooserError(ChooserError.Code.CACHE_FAILED, "Cannot create private cache directory.");
		}
		return root;
	}

	static File create(File cache) throws IOException {
		File root = directory(cache);
		for (int attempt = 0; attempt < 10; attempt++) {
			File file = new File(root, UUID.randomUUID().toString());
			if (file.createNewFile()) {
				return file;
			}
		}
		throw new ChooserError(ChooserError.Code.CACHE_FAILED, "Cannot allocate a unique cache file.");
	}

	// Directory lookup detects dangling links too; File.exists() follows their missing targets.
	static boolean entryExists(File file) throws IOException {
		String[] entries = file.getParentFile().list();
		if (entries == null) throw new ChooserError(ChooserError.Code.CACHE_FAILED, "Cannot inspect cache directory.");
		for (String entry : entries) if (entry.equals(file.getName())) return true;
		return false;
	}

	static void release(File cache, String id) throws IOException {
		if (!isId(id)) {
			throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Expected a managed file id.");
		}
		File file = new File(directory(cache), id);
		boolean exists = entryExists(file);
		if (!file.getCanonicalFile().equals(file.getAbsoluteFile()) || (exists && !file.isFile())) {
			throw new ChooserError(ChooserError.Code.INVALID_ARGUMENT, "Not a managed regular file.");
		}
		if (exists && !file.delete()) {
			throw new ChooserError(ChooserError.Code.RELEASE_FAILED, "Could not remove the cached file.");
		}
	}
}
