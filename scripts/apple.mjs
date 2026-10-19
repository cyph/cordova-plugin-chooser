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
		// An undefined override removes the inherited SDKROOT from child processes.
		SDKROOT: undefined,
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
