import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function prepareBridgingHeader(path) {
	const original = readFileSync(path, "utf8");
	const include = "#import <Cordova/Cordova.h>";
	const wrapped = [
		// Cordova 7 imports WKProcessPool declarations deprecated by Apple's SDK.
		// Keep this exception inside the third-party import; Swift stays strict.
		"#pragma clang diagnostic push",
		'#pragma clang diagnostic ignored "-Wdeprecated-declarations"',
		include,
		"#pragma clang diagnostic pop",
	].join("\n");
	if (original.includes(wrapped)) return;
	assert.equal(
		original.split(include).length,
		2,
		"Expected one Cordova umbrella import",
	);
	writeFileSync(path, original.replace(include, wrapped));
}

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
