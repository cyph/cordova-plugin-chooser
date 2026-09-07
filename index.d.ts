/** File metadata. Provider names and MIME types are descriptive, not security validation. */
declare namespace chooser {
	interface FileMetadata {
		name: string;
		mediaType: string;
		uri: string;
		/** Bytes reported by the provider, or null when unavailable. */
		size: number | null;
		/** Browser results own a Blob URL and include an id for releaseFile(). */
		id?: string;
	}

	interface FileData extends FileMetadata {
		data: Uint8Array;
		dataURI: string;
	}

	interface FileReference extends FileMetadata {
		/** Opaque identifier of the plugin-owned copy or Blob URL. */
		id: string;
		size: number;
		/** Original provider URI on Android/iOS; absent in browsers. */
		sourceUri?: string;
	}

	interface CopyOptions {
		accept?: string;
		/** Per-file byte limit. Omitted or zero means unlimited. */
		maxFileSize?: number;
		/** Selection count limit after native URI deduplication. Zero/omitted is unlimited. */
		maxFiles?: number;
		/** Aggregate byte limit across the selection. Zero/omitted is unlimited. */
		maxTotalSize?: number;
		/** Android only: restrict the chooser to local providers. Default false. */
		localOnly?: boolean;
	}

	type Success<T> = (result: T | undefined) => void;
	type Failure = (error: unknown) => void;

	function getFile(accept?: string, success?: Success<FileData>, failure?: Failure): Promise<FileData | undefined>;
	function getFile(success: Success<FileData>, failure?: Failure): Promise<FileData | undefined>;
	function getFileMetadata(accept?: string, success?: Success<FileMetadata>, failure?: Failure): Promise<FileMetadata | undefined>;
	function getFileMetadata(success: Success<FileMetadata>, failure?: Failure): Promise<FileMetadata | undefined>;
	function getFiles(accept?: string, success?: Success<FileData[]>, failure?: Failure): Promise<FileData[] | undefined>;
	function getFiles(success: Success<FileData[]>, failure?: Failure): Promise<FileData[] | undefined>;
	function getFilesMetadata(accept?: string, success?: Success<FileMetadata[]>, failure?: Failure): Promise<FileMetadata[] | undefined>;
	function getFilesMetadata(success: Success<FileMetadata[]>, failure?: Failure): Promise<FileMetadata[] | undefined>;
	function getFileUri(options?: CopyOptions | string, success?: Success<FileReference>, failure?: Failure): Promise<FileReference | undefined>;
	function getFileUri(success: Success<FileReference>, failure?: Failure): Promise<FileReference | undefined>;
	function getFilesUri(options?: CopyOptions | string, success?: Success<FileReference[]>, failure?: Failure): Promise<FileReference[] | undefined>;
	function getFilesUri(success: Success<FileReference[]>, failure?: Failure): Promise<FileReference[] | undefined>;
	function releaseFile(id: string, success?: () => void, failure?: Failure): Promise<void>;
}

export = chooser;
export as namespace chooser;
