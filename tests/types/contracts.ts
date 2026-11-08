import chooser = require('../..');

async function contracts(format: chooser.DataFormat, unknownReference: unknown, flag: boolean) {
	const controller = new AbortController();
	const file: chooser.ManagedFile = await chooser.getFile({maxFileSize: 1024, signal: controller.signal});
	const bytes: Uint8Array<ArrayBuffer> = await file.bytes({maxBytes: null});
	const part: Uint8Array<ArrayBuffer> = await file.readRange({offset: 0, length: 1048576});
	const buffer: ArrayBuffer = await file.arrayBuffer({maxBytes: 2048});
	const blob: Blob = await file.blob({maxBytes: 2048});
	const text: string = await file.text({maxBytes: 2048, encoding: 'utf-8', fatal: true});
	const uri: string = await file.dataURI({maxBytes: 2048});
	const stream: ReadableStream<Uint8Array<ArrayBuffer>> = file.stream({length: 1});
	const textStream: ReadableStream<string> = file.textStream({encoding: 'utf-8', fatal: false});
	new Blob([bytes, part, bytes.subarray(1), buffer]);
	new TextDecoder().decode(bytes);
	new Request('https://example.test/upload', {method: 'POST', body: bytes});
	crypto.subtle.digest('SHA-256', bytes);
	void blob; void text; void uri; void stream; void textStream;

	const files: chooser.NonEmptyArray<chooser.ManagedFile> = await chooser.getFiles({maxFileSize: null, maxTotalSize: null, maxFiles: null});
	const first: chooser.ManagedFile = files[0];
	const photo = await chooser.getFile({source: 'photos', mediaTypes: ['image', 'video'], maxFileSize: 1024});
	const metadata = await chooser.getFileMetadata({accept: ['text/plain', 'application/json'], preferLocal: true});
	const size: number | null = metadata.size;
	const metas = await chooser.getFilesMetadata({source: 'photos', mediaTypes: ['image'], maxFiles: 5});
	const firstMetadata: chooser.FileMetadata = metas[0];
	const data = await chooser.getFileData({format: 'bytes', maxFileSize: null});
	const binary: Uint8Array<ArrayBuffer> = data.data;
	const decoded = await chooser.getFileData({format: 'text', maxFileSize: 2048, fatal: false});
	const exactText: string = decoded.text;
	const encoded = await chooser.getFilesData({format: 'dataURI', maxFileSize: 1024, maxTotalSize: 2048});
	const dataURI: string = encoded[0].dataURI;
	const both = await file.getData({format: 'bytesAndDataURI', maxBytes: null});
	const bothBytes: Uint8Array<ArrayBuffer> = both.data;
	const bothURI: string = both.dataURI;
	const blobData = await chooser.getFileData({format: 'blob', maxFileSize: null, preferLocal: true});
	const directBlob: Blob = blobData.blob;
	const bufferData = await chooser.getFilesData({format: 'arrayBuffer', maxFileSize: null, maxTotalSize: null});
	const directBuffer: ArrayBuffer = bufferData[0].arrayBuffer;
	const managedBlob: Blob = (await file.getData({format: 'blob', maxBytes: null})).blob;
	const managedBuffer: ArrayBuffer = (await file.getData({format: 'arrayBuffer', maxBytes: null})).arrayBuffer;
	const directText: string = (await chooser.getFilesData({format: 'text', encoding: 'windows-1252', fatal: true, maxFileSize: null, maxTotalSize: null}))[0].text;
	const managedText: string = (await file.getData({format: 'text', maxBytes: null, encoding: 'utf-8', fatal: false})).text;
	const actualSize: number = blobData.size;
	const mediaType: string = blobData.mediaType;
	void directBlob; void directBuffer; void managedBlob; void managedBuffer; void directText; void managedText; void actualSize; void mediaType;
	const dynamic = await chooser.getFileData({format, maxFileSize: null});
	if (dynamic.format === 'text') { const value: string = dynamic.text; void value; }
	if (dynamic.format === 'bytesAndDataURI') { new Blob([dynamic.data]); dynamic.dataURI.toUpperCase(); }
	if (dynamic.format === 'blob') { const value: Blob = dynamic.blob; void value; }
	if (dynamic.format === 'arrayBuffer') { const value: ArrayBuffer = dynamic.arrayBuffer; void value; }
	const scoped: number = await chooser.withFile({maxFileSize: null}, async handle => (await handle.readRange({length: 2})).length);
	const explicit: number = await chooser.withFile<number>({maxFileSize: null}, async () => 1);
	const mixed: number | string = await chooser.withFile({maxFileSize: null}, () => flag ? 'sync' : Promise.resolve(1));
	const scopedFiles: number = await chooser.withFiles<number>({maxFileSize: null, maxTotalSize: null}, async values => values.length);
	const intentionallyVoid: undefined = await chooser.withFile({maxFileSize: null}, () => undefined);
	const restored: chooser.ManagedFile = await chooser.restoreFile(unknownReference, {signal: controller.signal});
	const reference: chooser.FileReference = restored.toJSON();
	const released: void = await chooser.releaseFile(reference.id);
	await chooser.releaseFiles([first.id, photo.id]);
	await file.release();
	void size; void firstMetadata; void binary; void exactText; void dataURI; void bothBytes; void bothURI;
	void scoped; void explicit; void mixed; void scopedFiles; void intentionallyVoid; void released;

	try { await chooser.getFile({maxFileSize: null}); }
	catch (error) {
		if (error instanceof chooser.CancellationError) {
			const code: 'CANCELLED' = error.code;
			const reason: 'picker' | 'signal' = error.reason;
			void code; void reason;
		}
		if (error instanceof chooser.CleanupError) {
			error.failures.forEach(failure => failure.error.code);
			if (error.outcome.status === 'fulfilled') void error.outcome.value;
			else void error.outcome.reason;
		}
	}
	new chooser.CleanupError({status: 'fulfilled', value: 42}, []);
	new chooser.ChooserError('READ_FAILED', 'read error', {cause: new Error('provider')});
	const oldOptions = {maxFileSize: null, maxTotalSize: null, localOnly: true};
	// @ts-expect-error Removed options also reject variables with otherwise valid budgets.
	chooser.getFile(oldOptions);
	// @ts-expect-error Removed document option is not accepted by plural methods either.
	chooser.getFiles(oldOptions);
	const oldMetadataOptions = {accept: 'text/plain', localOnly: false};
	// @ts-expect-error Metadata also rejects the obsolete option on a variable.
	chooser.getFileMetadata(oldMetadataOptions);

	// @ts-expect-error Selection byte budgets are explicit.
	chooser.getFile();
	// @ts-expect-error Plural selection also needs an aggregate budget.
	chooser.getFiles({maxFileSize: null});
	// @ts-expect-error Whole-file reads have an independent explicit memory budget.
	file.bytes();
	// @ts-expect-error The old managed read name has no alias.
	file.read({length: 1});
	// @ts-expect-error Metadata carries no managed URI.
	metadata.uri;
	// @ts-expect-error Metadata carries no binary data.
	metadata.data;
	// @ts-expect-error Byte results do not also generate a data URI.
	data.dataURI;
	// @ts-expect-error Direct data results do not own managed references.
	data.id;
	// @ts-expect-error Blob format wraps its representation with metadata.
	const rawBlob: Blob = blobData;
	// @ts-expect-error ArrayBuffer format wraps its representation with metadata.
	const rawBuffer: ArrayBuffer = bufferData[0];
	// @ts-expect-error Blob format owns no reference.
	blobData.uri;
	// @ts-expect-error No extra byte array is produced for ArrayBuffer format.
	bufferData[0].data;
	// @ts-expect-error Source options are discriminated.
	chooser.getFile({source: 'photos', accept: 'image/*', maxFileSize: null});
	// @ts-expect-error Photo types do not apply to document selection.
	chooser.getFile({mediaTypes: ['image'], maxFileSize: null});
	// @ts-expect-error Photos do not accept the Android document-provider hint.
	chooser.getFileMetadata({source: 'photos', preferLocal: true});
	// @ts-expect-error localOnly is removed from public document options.
	chooser.getFileMetadata({localOnly: false});
	// @ts-expect-error Callbacks are removed.
	chooser.getFileMetadata({}, () => {});
	// @ts-expect-error Legacy string overloads are removed.
	chooser.getFile('image/*');
	// @ts-expect-error Old URI entrypoints have been consolidated into getFile.
	chooser.getFileUri({maxFileSize: null});
	// @ts-expect-error A reference object is not a release identifier.
	chooser.releaseFile(reference);
	// @ts-expect-error Formats are explicit.
	chooser.getFileData({maxFileSize: null});
	// @ts-expect-error Decoding options cannot be applied to bytes, even with a broad generic.
	chooser.getFileData<chooser.DataFormat>({format: 'bytes', maxFileSize: null, fatal: false});
	// @ts-expect-error Managed format options retain the same correlation.
	file.getData<chooser.DataFormat>({format: 'dataURI', maxBytes: null, fatal: false});
	// @ts-expect-error Blob is binary even with a broad generic.
	chooser.getFileData<chooser.DataFormat>({format: 'blob', maxFileSize: null, encoding: 'utf-8'});
	// @ts-expect-error ArrayBuffer is binary even with a broad generic.
	chooser.getFilesData<chooser.DataFormat>({format: 'arrayBuffer', maxFileSize: null, maxTotalSize: null, fatal: false});
	// @ts-expect-error Text decoding options are flat.
	chooser.getFileData({format: 'text', maxFileSize: null, decoding: {fatal: false}});
	// @ts-expect-error Managed text decoding is flat too.
	file.getData({format: 'text', maxBytes: null, decoding: {encoding: 'utf-8'}});
	// @ts-expect-error Raw whole text reads do not accept nesting.
	file.text({maxBytes: null, decoding: {fatal: false}});
	// @ts-expect-error Text streams do not accept nesting.
	file.textStream({decoding: {fatal: false}});
	const binaryTextOptions = {format: 'blob' as const, maxFileSize: null, fatal: false};
	// @ts-expect-error Binary/text option correlation survives variables.
	chooser.getFileData(binaryTextOptions);
	// @ts-expect-error Unrecognized wrapper options are unsupported.
	chooser.getFileData({mimeTypes: 'text/csv', format: 'bytes', maxFileSize: 10});
	// @ts-expect-error No cancellation policy switch exists.
	chooser.getFile({maxFileSize: null, cancel: 'return'});
	// @ts-expect-error Selection counts are numeric or null.
	chooser.getFilesMetadata({maxFiles: '3'});
	// @ts-expect-error References are immutable descriptions.
	reference.size = 5;
}
void contracts;
