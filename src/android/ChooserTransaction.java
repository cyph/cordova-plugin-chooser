package com.cyph.cordova;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Logger;
import java.util.function.BooleanSupplier;

/** Cache-only work never waits behind document-provider I/O. */
final class ChooserTransaction {
	static final ExecutorService HOUSEKEEPING = Executors.newSingleThreadExecutor(action -> {
		Thread thread = new Thread(action, "Chooser-cache");
		thread.setDaemon(true);
		return thread;
	});
	interface Operations {
		boolean move(File from, File to);
		boolean delete(File file);
	}
	static final Operations FILES = new Operations() {
		public boolean move(File from, File to) { return from.renameTo(to); }
		public boolean delete(File file) { return file.delete(); }
	};
	private static final Set<String> initialized = new HashSet<>();
	private static final Logger LOG = Logger.getLogger("Chooser");
	private static final class Entry {
		final String id;
		boolean promoting;
		Entry(String id, boolean promoting) { this.id = id; this.promoting = promoting; }
	}
	private final File root;
	final File staging;
	private final Operations operations;
	private final List<Entry> entries = new ArrayList<>();
	private boolean committed;
	private boolean settled;

	static ChooserTransaction begin(File cache) throws IOException {
		synchronized (ChooserTransaction.class) {
			File root = ChooserFiles.directory(cache);
			if (!initialized.contains(root.getPath())) {
				recover(cache, FILES);
				initialized.add(root.getPath());
			}
			return new ChooserTransaction(cache, FILES);
		}
	}

	ChooserTransaction(File cache, Operations operations) throws IOException {
		this.root = ChooserFiles.directory(cache);
		this.operations = operations;
		File parent = directory(new File(root, ".pending"));
		File created = null;
		for (int attempt = 0; attempt < 10; attempt++) {
			File candidate = new File(parent, UUID.randomUUID().toString());
			if (candidate.mkdir()) { created = candidate; break; }
		}
		if (created == null) throw failure();
		staging = created;
	}

	File create() throws IOException {
		if (committed || settled) throw failure();
		for (int attempt = 0; attempt < 10; attempt++) {
			String id = UUID.randomUUID().toString();
			File file = new File(staging, id);
			if (!new File(root, id).exists() && file.createNewFile()) {
				entries.add(new Entry(id, false));
				return file;
			}
		}
		throw failure();
	}

	File destination(File staged) throws IOException {
		if (!staged.getParentFile().equals(staging) || !ChooserFiles.isId(staged.getName())) throw failure();
		return new File(root, staged.getName());
	}

	void commit() throws IOException { commit(() -> false); }

	void commit(BooleanSupplier canceled) throws IOException {
		if (committed || settled) throw failure();
		String[] names = root.list();
		if (names == null) throw failure();
		Set<String> existing = new HashSet<>(Arrays.asList(names));
		for (Entry entry : entries) {
			checkCanceled(canceled);
			regular(new File(staging, entry.id));
			File target = new File(root, entry.id);
			if (existing.contains(entry.id) || !target.getCanonicalFile().equals(target.getAbsoluteFile())) throw failure();
			entry.promoting = true;
		}
		// One atomic intent record covers the batch; source absence proves promotion.
		save(false);
		for (Entry entry : entries) {
			checkCanceled(canceled);
			if (!operations.move(new File(staging, entry.id), new File(root, entry.id))) throw failure();
		}
		checkCanceled(canceled);
		save(true);
		committed = true;
	}

	void finish(boolean delivered) {
		if (settled) return;
		settled = true;
		if (!delivered || !committed) {
			try { save(false); }
			catch (IOException error) { diagnostic(); }
			try { rollback(root, staging, entries, operations); }
			catch (IOException error) { diagnostic(); return; }
		}
		try { removeStaging(staging, operations); }
		catch (IOException error) { diagnostic(); }
	}

	private void save(boolean complete) throws IOException {
		StringBuilder journal = new StringBuilder("chooser-1\n").append(complete ? "committed\n" : "pending\n");
		for (Entry entry : entries) journal.append(entry.promoting ? "p:" : "s:").append(entry.id).append('\n');
		File temp = new File(staging, "journal.tmp");
		if (ChooserFiles.entryExists(temp)) regular(temp);
		try (FileOutputStream output = new FileOutputStream(temp)) {
			output.write(journal.toString().getBytes(StandardCharsets.US_ASCII));
			output.getFD().sync();
		}
		File journalFile = new File(staging, "journal");
		if (ChooserFiles.entryExists(journalFile)) regular(journalFile);
		if (!operations.move(temp, journalFile)) throw failure();
	}

	/** Invoke only before starting transactions in a process; never sweep active writers. */
	static void recover(File cache, Operations operations) throws IOException {
		File root = ChooserFiles.directory(cache);
		File parent = directory(new File(root, ".pending"));
		File[] children = parent.listFiles();
		if (children == null) throw failure();
		for (File folder : children) {
			try {
				if (!ChooserFiles.isId(folder.getName())) throw failure();
				directory(folder);
				List<Entry> entries = new ArrayList<>();
				boolean complete = false;
				File journal = new File(folder, "journal");
				if (journal.exists()) {
					regular(journal);
					try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(journal), StandardCharsets.US_ASCII))) {
						if (!"chooser-1".equals(record(reader))) throw failure();
						String phase = record(reader);
						if (!"pending".equals(phase) && !"committed".equals(phase)) throw failure();
						complete = "committed".equals(phase);
						Set<String> ids = new HashSet<>();
						String line;
						while ((line = record(reader)) != null) {
							if (!(line.startsWith("s:") || line.startsWith("p:"))) throw failure();
							String id = line.substring(2);
							if (!ChooserFiles.isId(id) || !ids.add(id)) throw failure();
							entries.add(new Entry(id, line.startsWith("p:")));
						}
					}
				}
				if (!complete) rollback(root, folder, entries, operations);
				removeStaging(folder, operations);
			}
			catch (IOException error) { diagnostic(); }
		}
	}

	private static String record(BufferedReader reader) throws IOException {
		StringBuilder line = new StringBuilder();
		int value;
		while ((value = reader.read()) != -1 && value != '\n') {
			if (value > 127 || line.length() >= 40) throw failure();
			line.append((char) value);
		}
		return value == -1 && line.length() == 0 ? null : line.toString();
	}

	private static void rollback(File root, File folder, List<Entry> entries, Operations operations) throws IOException {
		// Do not remove staged sources until all promoted-file deletions succeed.
		boolean failed = false;
		for (Entry entry : entries) {
			try {
				File source = new File(folder, entry.id);
				if (entry.promoting && !source.exists()) removeRegular(new File(root, entry.id), operations);
			}
			catch (IOException error) { failed = true; }
		}
		if (failed) throw failure();
	}

	private static void removeStaging(File folder, Operations operations) throws IOException {
		File[] files = folder.listFiles();
		if (files == null) throw failure();
		// Validate the complete flat directory before deleting any journal evidence.
		for (File file : files) {
			if (!ChooserFiles.isId(file.getName()) && !file.getName().equals("journal") && !file.getName().equals("journal.tmp")) throw failure();
			regular(file);
		}
		for (File file : files) if (!file.getName().startsWith("journal")) removeRegular(file, operations);
		removeRegular(new File(folder, "journal.tmp"), operations);
		removeRegular(new File(folder, "journal"), operations);
		if (!operations.delete(folder)) throw failure();
	}
	private static void removeRegular(File file, Operations operations) throws IOException {
		if (!file.getCanonicalFile().equals(file.getAbsoluteFile())) throw failure();
		if (file.exists() && !operations.delete(regular(file))) throw failure();
	}
	private static File regular(File file) throws IOException {
		if (!file.getCanonicalFile().equals(file.getAbsoluteFile()) || !file.isFile()) throw failure();
		return file;
	}
	private static File directory(File file) throws IOException {
		if (!file.getCanonicalFile().equals(file.getAbsoluteFile())) throw failure();
		if (!file.isDirectory() && !file.mkdir()) throw failure();
		return file;
	}
	private static void checkCanceled(BooleanSupplier canceled) throws ChooserError {
		if (canceled.getAsBoolean()) throw new ChooserError(ChooserError.Code.READ_INTERRUPTED, "Request was reset.");
	}
	private static ChooserError failure() { return new ChooserError(ChooserError.Code.CACHE_FAILED, "Cache transaction could not be completed."); }
	private static void diagnostic() { LOG.warning("Chooser cache cleanup/recovery incomplete; private entries retained for retry."); }
}
