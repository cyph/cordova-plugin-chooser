package com.cyph.cordova;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class ChooserTransactionTest {
	@Rule public TemporaryFolder temporary = new TemporaryFolder();

	private static class Faults implements ChooserTransaction.Operations {
		int moves;
		int failMove;
		File refuseDelete;
		public boolean move(File from, File to) {
			if (ChooserFiles.isId(from.getName()) && ++moves == failMove) return false;
			return ChooserTransaction.FILES.move(from, to);
		}
		public boolean delete(File file) {
			return !file.equals(refuseDelete) && ChooserTransaction.FILES.delete(file);
		}
	}

	private File write(ChooserTransaction transaction, int value) throws Exception {
		File file = transaction.create();
		Files.write(file.toPath(), new byte[]{(byte) value});
		return file;
	}

	@Test public void successfulBatchPromotesOnlyAtCommitAndSurvivesBookkeepingRecovery() throws Exception {
		File cache = temporary.newFolder();
		ChooserTransaction transaction = new ChooserTransaction(cache, ChooserTransaction.FILES);
		File source = write(transaction, 42);
		File destination = transaction.destination(source);
		assertFalse(destination.exists());
		transaction.commit();
		assertFalse(source.exists());
		assertArrayEquals(new byte[]{42}, Files.readAllBytes(destination.toPath()));
		// Simulate process exit after commit but before housekeeping removes the journal.
		ChooserTransaction.recover(cache, ChooserTransaction.FILES);
		assertFalse(transaction.staging.exists());
		assertArrayEquals(new byte[]{42}, Files.readAllBytes(destination.toPath()));
		ChooserFiles.release(cache, destination.getName());
		assertFalse(destination.exists());
	}

	@Test public void startupRecoveryRemovesUnjournaledCopiesButNeverSweepsAnActiveRequest() throws Exception {
		File cache = temporary.newFolder();
		ChooserTransaction abandoned = new ChooserTransaction(cache, ChooserTransaction.FILES);
		write(abandoned, 1);
		ChooserTransaction active = ChooserTransaction.begin(cache);
		assertFalse(abandoned.staging.exists());
		File source = write(active, 2);
		ChooserTransaction another = ChooserTransaction.begin(cache);
		assertTrue(source.exists());
		active.finish(false);
		another.finish(false);
		assertFalse(active.staging.exists());
		assertFalse(another.staging.exists());
	}

	@Test public void partialPromotionIsRolledBackAfterProcessExit() throws Exception {
		File cache = temporary.newFolder();
		Faults faults = new Faults();
		faults.failMove = 2;
		ChooserTransaction transaction = new ChooserTransaction(cache, faults);
		File first = write(transaction, 1);
		File second = write(transaction, 2);
		assertThrows(IOException.class, transaction::commit);
		assertTrue(transaction.destination(first).exists());
		assertTrue(second.exists());
		ChooserTransaction.recover(cache, ChooserTransaction.FILES);
		assertFalse(transaction.destination(first).exists());
		assertFalse(transaction.destination(second).exists());
		assertFalse(transaction.staging.exists());
	}

	@Test public void resetDuringPromotionStopsAndRollsBackTheBatch() throws Exception {
		Faults faults = new Faults();
		ChooserTransaction transaction = new ChooserTransaction(temporary.newFolder(), faults);
		File first = transaction.destination(write(transaction, 1));
		File second = transaction.destination(write(transaction, 2));
		ChooserError error = assertThrows(ChooserError.class, () -> transaction.commit(() -> faults.moves > 0));
		assertEquals(ChooserError.Code.READ_INTERRUPTED, error.code);
		assertEquals(1, faults.moves);
		transaction.finish(false);
		assertFalse(first.exists());
		assertFalse(second.exists());
		assertFalse(transaction.staging.exists());
	}

	@Test public void journalTemporaryFileCannotFollowADanglingLink() throws Exception {
		ChooserTransaction transaction = new ChooserTransaction(temporary.newFolder(), ChooserTransaction.FILES);
		File destination = transaction.destination(write(transaction, 1));
		File foreign = new File(temporary.getRoot(), "must-not-create");
		Files.createSymbolicLink(new File(transaction.staging, "journal.tmp").toPath(), foreign.toPath());
		assertThrows(IOException.class, transaction::commit);
		transaction.finish(false);
		assertFalse(foreign.exists());
		assertFalse(destination.exists());
		assertTrue(transaction.staging.exists());
	}

	@Test public void undeliveredCommittedBatchAndFailedDeletionRemainRecoverable() throws Exception {
		File cache = temporary.newFolder();
		Faults faults = new Faults();
		ChooserTransaction transaction = new ChooserTransaction(cache, faults);
		File first = transaction.destination(write(transaction, 1));
		File second = transaction.destination(write(transaction, 2));
		transaction.commit();
		faults.refuseDelete = first;
		transaction.finish(false);
		assertTrue(first.exists());
		assertFalse(second.exists()); // One failed deletion must not skip the other files.
		assertTrue(new File(transaction.staging, "journal").isFile());
		ChooserTransaction.recover(cache, ChooserTransaction.FILES);
		assertFalse(first.exists());
		assertFalse(transaction.staging.exists());
	}

	@Test public void successfulDeliveryKeepsFilesAndCleanupIsIdempotent() throws Exception {
		ChooserTransaction transaction = new ChooserTransaction(temporary.newFolder(), ChooserTransaction.FILES);
		File destination = transaction.destination(write(transaction, 1));
		transaction.commit();
		transaction.finish(true);
		transaction.finish(false);
		assertTrue(destination.exists());
		assertFalse(transaction.staging.exists());
	}

	@Test public void destinationCollisionDoesNotDeleteAnExistingReference() throws Exception {
		ChooserTransaction transaction = new ChooserTransaction(temporary.newFolder(), ChooserTransaction.FILES);
		File source = write(transaction, 1);
		File destination = transaction.destination(source);
		Files.write(destination.toPath(), new byte[]{99});
		assertThrows(IOException.class, transaction::commit);
		transaction.finish(false);
		assertArrayEquals(new byte[]{99}, Files.readAllBytes(destination.toPath()));
	}

	@Test public void recoveryRejectsMalformedJournalsAndSymlinkTargets() throws Exception {
		File cache = temporary.newFolder();
		File foreign = temporary.newFile();
		Files.write(foreign.toPath(), new byte[]{99});
		ChooserTransaction malformed = new ChooserTransaction(cache, ChooserTransaction.FILES);
		Files.write(new File(malformed.staging, "journal").toPath(), "chooser-1\npending\np:../../foreign\n".getBytes(StandardCharsets.US_ASCII));
		ChooserTransaction linked = new ChooserTransaction(cache, ChooserTransaction.FILES);
		File source = write(linked, 1);
		File destination = linked.destination(source);
		linked.commit();
		Files.delete(destination.toPath());
		Files.createSymbolicLink(destination.toPath(), foreign.toPath());
		Files.write(new File(linked.staging, "journal").toPath(), ("chooser-1\npending\np:" + destination.getName() + "\n").getBytes(StandardCharsets.US_ASCII));
		ChooserTransaction.recover(cache, ChooserTransaction.FILES);
		assertArrayEquals(new byte[]{99}, Files.readAllBytes(foreign.toPath()));
		assertTrue(Files.isSymbolicLink(destination.toPath()));
		assertTrue(new File(linked.staging, "journal").exists());
		assertTrue(new File(malformed.staging, "journal").exists());
	}
}
