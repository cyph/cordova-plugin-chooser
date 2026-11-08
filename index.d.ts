/** Document and photo selection, bounded reading, and managed temporary resources. */
declare namespace chooser {
	type FileId = string;
	/** Positive safe integer in bytes, or null to explicitly allow any size. */
	type ByteLimit = number | null;
	type NonEmptyArray<T> = readonly [T, ...T[]];

	interface OperationOptions { signal?: AbortSignal; }
	interface DocumentSourceOptions {
		source?: 'documents';
		accept?: string | readonly string[];
		/** Android provider hint; default false. */
		preferLocal?: boolean;
		localOnly?: never;
		mediaTypes?: never;
	}
	interface PhotoSourceOptions {
		source: 'photos';
		/** Default: images and videos. */
		mediaTypes?: readonly ('image' | 'video')[];
		accept?: never;
		preferLocal?: never;
		localOnly?: never;
	}
	type SelectionOptions = OperationOptions & (DocumentSourceOptions | PhotoSourceOptions);
	interface MultipleSelectionOptions {
		/** Positive count, or omitted/null for no plugin-imposed count limit. */
		maxFiles?: number | null;
	}
	type GetFileOptions = SelectionOptions & {maxFileSize: ByteLimit};
	type GetFilesOptions = GetFileOptions & MultipleSelectionOptions & {maxTotalSize: ByteLimit};
	type GetFileMetadataOptions = SelectionOptions;
	type GetFilesMetadataOptions = SelectionOptions & MultipleSelectionOptions;

	interface FileMetadata {
		readonly name: string;
		readonly mediaType: string;
		/** Provider-reported size; null when unavailable. */
		readonly size: number | null;
		/** Borrowed native provider reference; not owned by this plugin. */
		readonly sourceUri?: string;
	}
	interface FileReference extends FileMetadata {
		readonly id: FileId;
		/** Actual size of the managed resource. */
		readonly size: number;
		/** Owned cache URI or Blob URL, valid until release or cache eviction. */
		readonly uri: string;
	}

	interface TextDecodingOptions {
		/** Default: utf-8. Supported labels follow TextDecoder. */
		encoding?: string;
		/** Default true; false replaces malformed input. */
		fatal?: boolean;
	}
	interface WholeFileReadOptions extends OperationOptions { maxBytes: ByteLimit; }
	type TextReadOptions = WholeFileReadOptions & TextDecodingOptions;
	interface RangeReadOptions extends OperationOptions {
		offset?: number;
		/** Nonnegative safe integer; ranges may exceed the internal bridge chunk size. */
		length: number;
	}
	interface StreamOptions extends OperationOptions {
		offset?: number;
		length?: number;
	}
	type TextStreamOptions = StreamOptions & TextDecodingOptions;

	type DataFormat = 'bytes' | 'text' | 'dataURI' | 'bytesAndDataURI' | 'blob' | 'arrayBuffer';
	interface DataResultMap {
		bytes: {readonly format: 'bytes'; readonly data: Uint8Array<ArrayBuffer>};
		text: {readonly format: 'text'; readonly text: string};
		dataURI: {readonly format: 'dataURI'; readonly dataURI: string};
		bytesAndDataURI: {readonly format: 'bytesAndDataURI'; readonly data: Uint8Array<ArrayBuffer>; readonly dataURI: string};
		blob: {readonly format: 'blob'; readonly blob: Blob};
		arrayBuffer: {readonly format: 'arrayBuffer'; readonly arrayBuffer: ArrayBuffer};
	}
	type FileData<F extends DataFormat = DataFormat> = FileMetadata & {readonly size: number} & DataResultMap[F];
	type DataOptions<F extends DataFormat> = {format: F; decoding?: never} & (
		{encoding?: never; fatal?: never} | ({format: 'text'} & TextDecodingOptions)
	);
	type GetFileDataOptions<F extends DataFormat> = GetFileOptions & DataOptions<F>;
	type GetFilesDataOptions<F extends DataFormat> = GetFilesOptions & DataOptions<F>;
	type ManagedDataOptions<F extends DataFormat> = WholeFileReadOptions & DataOptions<F>;

	interface ManagedFile extends FileReference {
		bytes(options: WholeFileReadOptions): Promise<Uint8Array<ArrayBuffer>>;
		arrayBuffer(options: WholeFileReadOptions): Promise<ArrayBuffer>;
		blob(options: WholeFileReadOptions): Promise<Blob>;
		text(options: TextReadOptions): Promise<string>;
		dataURI(options: WholeFileReadOptions): Promise<string>;
		getData<F extends DataFormat>(options: ManagedDataOptions<F>): Promise<FileData<F>>;
		/** Returns a short result at EOF, including an empty result beyond EOF. */
		readRange(options: RangeReadOptions): Promise<Uint8Array<ArrayBuffer>>;
		stream(options?: StreamOptions): ReadableStream<Uint8Array<ArrayBuffer>>;
		textStream(options?: TextStreamOptions): ReadableStream<string>;
		/** Stops streams, waits for started one-shot reads, and releases this ID across all aliases. */
		release(): Promise<void>;
		toJSON(): FileReference;
	}

	function getFile(options: GetFileOptions): Promise<ManagedFile>;
	function getFiles(options: GetFilesOptions): Promise<NonEmptyArray<ManagedFile>>;
	function getFileMetadata(options?: GetFileMetadataOptions): Promise<FileMetadata>;
	function getFilesMetadata(options?: GetFilesMetadataOptions): Promise<NonEmptyArray<FileMetadata>>;
	function getFileData<F extends DataFormat>(options: GetFileDataOptions<F>): Promise<FileData<F>>;
	function getFilesData<F extends DataFormat>(options: GetFilesDataOptions<F>): Promise<NonEmptyArray<FileData<F>>>;

	/** Await all work using the resource inside consume; cleanup follows its settlement. */
	function withFile<T>(options: GetFileOptions, consume: (file: ManagedFile) => T): Promise<Awaited<T>>;
	function withFile<T>(options: GetFileOptions, consume: (file: ManagedFile) => T | PromiseLike<T>): Promise<Awaited<T>>;
	function withFiles<T>(options: GetFilesOptions, consume: (files: NonEmptyArray<ManagedFile>) => T): Promise<Awaited<T>>;
	function withFiles<T>(options: GetFilesOptions, consume: (files: NonEmptyArray<ManagedFile>) => T | PromiseLike<T>): Promise<Awaited<T>>;
	/** Validate an untrusted saved reference and obtain authoritative status from the plugin. */
	function restoreFile(reference: unknown, options?: OperationOptions): Promise<ManagedFile>;
	function releaseFile(id: FileId): Promise<void>;
	/** Validates every ID before mutation, attempts all unique IDs, and reports per-ID failures. */
	function releaseFiles(ids: readonly FileId[]): Promise<void>;

	type ErrorCode = 'INVALID_ARGUMENT' | 'BUSY' | 'CANCELLED' | 'UNSUPPORTED' | 'PICKER_FAILED' |
		'PERMISSION_DENIED' | 'FILE_TOO_LARGE' | 'TOO_MANY_FILES' | 'TOTAL_SIZE_EXCEEDED' |
		'READ_FAILED' | 'DECODE_FAILED' | 'COPY_FAILED' | 'CACHE_FAILED' | 'FILE_UNAVAILABLE' |
		'FILE_RELEASED' | 'RELEASE_FAILED' | 'CLEANUP_FAILED' | 'OUT_OF_MEMORY';
	interface ReleaseFailure { readonly id: FileId; readonly error: ChooserError; }
	interface ErrorOptions { cause?: unknown; failures?: readonly ReleaseFailure[]; }
	class ChooserError extends Error {
		readonly name: string;
		readonly code: ErrorCode;
		readonly cause?: unknown;
		readonly failures?: readonly ReleaseFailure[];
		constructor(code: ErrorCode, message: string, options?: ErrorOptions);
	}
	class CancellationError extends ChooserError {
		readonly name: 'CancellationError';
		readonly code: 'CANCELLED';
		readonly reason: 'picker' | 'signal';
		constructor(reason: 'picker' | 'signal', options?: ErrorOptions);
	}
	type OperationOutcome<T = unknown> =
		{readonly status: 'fulfilled'; readonly value: T} |
		{readonly status: 'rejected'; readonly reason: unknown};
	class CleanupError<T = unknown> extends ChooserError {
		readonly name: 'CleanupError';
		readonly code: 'CLEANUP_FAILED';
		readonly outcome: OperationOutcome<T>;
		readonly failures: readonly ReleaseFailure[];
		constructor(outcome: OperationOutcome<T>, failures: readonly ReleaseFailure[]);
	}
}

export = chooser;
export as namespace chooser;
