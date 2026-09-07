import chooser = require('../..');

async function contracts() {
	const file = await chooser.getFile();
	if (file) {
		const bytes: Uint8Array = file.data;
		const dataURI: string = file.dataURI;
		void bytes; void dataURI;
	}
	chooser.getFile(file => { if (file) file.data.byteLength; }, error => { void error; });
	chooser.getFileMetadata('image/*', file => { if (file) file.uri; });
	const metadata = await chooser.getFileMetadata();
	if (metadata) {
		const size: number | null = metadata.size;
		void size;
		// @ts-expect-error Metadata does not materialize binary data.
		metadata.data;
	}
	const files = await chooser.getFiles();
	files?.forEach(file => file.data.byteLength);
	chooser.getFilesMetadata(files => { files?.forEach(file => file.uri); });
	const refs = await chooser.getFilesUri({maxFileSize: 1024, maxFiles: 3, maxTotalSize: 2048, localOnly: false});
	if (refs) for (const ref of refs) await chooser.releaseFile(ref.id);
	chooser.getFileUri(ref => { if (ref) chooser.releaseFile(ref.id, () => {}); });
	const released: void = await chooser.releaseFile('00000000-0000-4000-8000-000000000001');
	void released;
	// @ts-expect-error Copy byte limits are numeric.
	chooser.getFileUri({maxFileSize: '100'});
	// @ts-expect-error Selection counts are numeric.
	chooser.getFilesUri({maxFiles: '3'});
	// @ts-expect-error Aggregate byte limits are numeric.
	chooser.getFileUri({maxTotalSize: true});
	// @ts-expect-error A result object is not a release identifier.
	chooser.releaseFile({uri: 'file:///source'});
}
void contracts;
