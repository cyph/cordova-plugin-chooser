import { join } from "node:path";

export function appleEnvironment(apple, inherited = process.env) {
	// Nix's Darwin SDK hook provides a macOS-only developer directory.
	const requested = inherited.DEVELOPER_DIR;
	const directory =
		requested && !requested.startsWith("/nix/store/")
			? requested
			: apple.developerDirectory;
	return {
		DEVELOPER_DIR: directory,
		// Undefined overrides let Xcode select its SDK and compiler toolchain.
		SDKROOT: undefined,
		CC: undefined,
		CXX: undefined,
		CPP: undefined,
		LD: undefined,
		AR: undefined,
		AS: undefined,
		NM: undefined,
		RANLIB: undefined,
		STRIP: undefined,
		LIBTOOL: undefined,
		SWIFT_EXEC: undefined,
		PATH: [
			join(directory, "usr/bin"),
			inherited.PATH,
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]
			.filter(Boolean)
			.join(":"),
	};
}
