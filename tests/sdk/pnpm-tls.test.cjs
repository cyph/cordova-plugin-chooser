const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { once } = require("node:events");
const {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { createServer } = require("node:https");
const { tmpdir } = require("node:os");
const { delimiter, isAbsolute, join, resolve } = require("node:path");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const root = resolve(__dirname, "../..");

function executable(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		const path = join(directory, name);
		try {
			accessSync(path, constants.X_OK);
			if (!statSync(path).isFile()) continue;
		} catch {
			continue;
		}
		const owned = realpathSync(path);
		assert.match(owned, /^\/nix\/store\//, `${name} must come from Nix`);
		return owned;
	}
	assert.fail(`Missing ${name} in the pinned Nix profile`);
}

async function command(file, args, options) {
	try {
		return {
			...(await execute(file, args, {
				...options,
				encoding: "utf8",
				timeout: 18_000,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
			})),
			code: 0,
		};
	} catch (error) {
		// A timeout, signal, missing executable or full buffer is never a TLS result.
		assert.equal(error.signal, null, error.message);
		assert.equal(typeof error.code, "number", error.message);
		assert.equal(error.killed, false, error.message);
		return error;
	}
}

test(
	"native pinned pnpm qualifies registry TLS with exclusive CA trust",
	{ timeout: 180_000 },
	async (t) => {
		const locks = ["pnpm-lock.yaml", "flake.lock", "chainman.lock"].map(
			(name) => [name, readFileSync(join(root, name))],
		);
		t.after(() => {
			for (const [name, bytes] of locks) {
				assert.deepEqual(
					readFileSync(join(root, name)),
					bytes,
					`${name} changed`,
				);
			}
		});
		const pin = JSON.parse(
			readFileSync(join(root, "chainman/tools.json")),
		).pnpm;
		assert(
			Number(pin.version.split(".")[0]) >= 12,
			"Native pnpm 12 or newer is required",
		);
		const pnpm = executable("pnpm");
		assert(pnpm.endsWith(`-pnpm-${pin.version}/bin/pnpm`), pnpm);
		assert.match(realpathSync(process.execPath), /^\/nix\/store\//);
		const openssl = executable("openssl");
		assert(
			process.env.SSL_CERT_FILE,
			"Run with the pinned profile's curated trust",
		);
		const curated = realpathSync(process.env.SSL_CERT_FILE);
		assert.match(
			curated,
			/^\/nix\/store\//,
			"Use the profile's curated CA bundle",
		);
		assert.match(readFileSync(curated, "utf8"), /-----BEGIN CERTIFICATE-----/);
		const directory = mkdtempSync(join(tmpdir(), "chooser-pnpm-tls-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		assert(
			!realpathSync(directory).startsWith(`${realpathSync(root)}/`),
			"Probe outside the checkout",
		);
		const bin = join(directory, "bin");
		const emptyCA = join(directory, "empty-ca");
		const emptyConfig = join(directory, "empty-config");
		mkdirSync(bin);
		mkdirSync(emptyCA);
		symlinkSync(process.execPath, join(bin, "node"));
		writeFileSync(emptyConfig, "");

		function isolated(name, ca = curated) {
			const cwd = join(directory, name);
			const home = join(cwd, "home");
			mkdirSync(home, { recursive: true });
			writeFileSync(
				join(cwd, "package.json"),
				JSON.stringify({ name: "chooser-tls-probe", private: true }),
			);
			writeFileSync(
				join(cwd, "pnpm-workspace.yaml"),
				"packages: []\nfetchRetries: 0\nfetchTimeout: 5000\nstrictSsl: true\n",
			);
			// An allowlist drops credentials, proxies, npm/pnpm config, Node options,
			// extra roots and TLS bypasses. Every request gets a fresh HOME and cache.
			return {
				cwd,
				env: {
					PATH: bin,
					HOME: home,
					TMPDIR: directory,
					XDG_CONFIG_HOME: join(home, "config"),
					XDG_CACHE_HOME: join(home, "cache"),
					XDG_DATA_HOME: join(home, "data"),
					SSL_CERT_FILE: ca,
					SSL_CERT_DIR: emptyCA,
					LANG: "C",
					LC_ALL: "C",
					CI: "true",
				},
			};
		}

		// Probe outside the checkout before permitting --pm-on-fail=ignore, which
		// must never conceal selection of a different package manager version.
		const identity = await command(pnpm, ["--version"], isolated("identity"));
		assert.equal(identity.code, 0, identity.stdout + identity.stderr);
		assert.equal(identity.stdout.trim(), pin.version);
		const crypto = isolated("certificates");
		const cryptoVersion = await command(openssl, ["version"], crypto);
		assert.equal(cryptoVersion.code, 0, cryptoVersion.stderr);
		assert(
			Number(cryptoVersion.stdout.match(/^OpenSSL (\d+)\./)?.[1]) >= 3,
			"OpenSSL 3 or newer is required",
		);

		for (const name of ["a", "b"]) {
			const key = join(directory, `${name}.key`);
			writeFileSync(key, "", { mode: 0o600 });
			const generated = await command(
				openssl,
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-noenc",
					"-sha256",
					"-config",
					emptyConfig,
					"-keyout",
					key,
					"-out",
					join(directory, `${name}.crt`),
					"-days",
					"1",
					"-subj",
					name === "a" ? "/CN=localhost" : "/CN=Unrelated chooser TLS CA",
					"-addext",
					`basicConstraints=critical,CA:${name === "a" ? "FALSE" : "TRUE"}`,
					"-addext",
					`keyUsage=critical,${name === "a" ? "digitalSignature,keyEncipherment" : "keyCertSign"}`,
					...(name === "a"
						? [
								"-addext",
								"subjectAltName=DNS:localhost,IP:127.0.0.1",
								"-addext",
								"extendedKeyUsage=serverAuth",
							]
						: []),
				],
				crypto,
			);
			assert.equal(generated.code, 0, generated.stderr);
		}

		const requests = [];
		const server = createServer(
			{
				key: readFileSync(join(directory, "a.key")),
				cert: readFileSync(join(directory, "a.crt")),
				handshakeTimeout: 5_000,
			},
			(request, response) => {
				requests.push({ method: request.method, path: request.url });
				if (request.method !== "GET" || request.url !== "/chooser-tls-probe") {
					response.writeHead(404).end();
					return;
				}
				// Only metadata is served: no tarball or installation can satisfy this.
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				});
				response.end(
					JSON.stringify({
						name: "chooser-tls-probe",
						"dist-tags": { latest: "1.0.0" },
						versions: {
							"1.0.0": {
								name: "chooser-tls-probe",
								version: "1.0.0",
								// Required by the resolver, but this endpoint deliberately returns 404.
								dist: {
									tarball: `${loopback}chooser-tls-probe/-/never-served.tgz`,
								},
							},
						},
					}),
				);
			},
		);
		server.requestTimeout = 5_000;
		server.setTimeout(5_000, (socket) => socket.destroy());
		t.after(async () => {
			const closed = new Promise((resolve) => server.close(resolve));
			server.closeAllConnections();
			await closed;
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const loopback = `https://127.0.0.1:${server.address().port}/`;

		async function view(name, ca, registry, packageName) {
			const options = isolated(name, ca);
			return command(
				pnpm,
				[
					"view",
					packageName,
					"version",
					`--registry=${registry}`,
					"--pm-on-fail=ignore",
					`--npmrc-auth-file=${emptyConfig}`,
					`--store-dir=${join(options.cwd, "store")}`,
					`--state-dir=${join(options.cwd, "state")}`,
				],
				options,
			);
		}

		function rejected(result) {
			const output = result.stdout + result.stderr;
			assert.equal(result.code, 1, output);
			assert.equal(result.stdout.trim(), "", output);
			// A DNS, connectivity, timeout or configuration failure cannot pass.
			assert.match(
				result.stderr,
				/invalid peer certificate:[\s\S]*UnknownIssuer/,
			);
		}

		await t.test("curated roots reject self-signed loopback A", async () => {
			rejected(
				await view("loopback-default", curated, loopback, "chooser-tls-probe"),
			);
			assert.deepEqual(requests, []);
		});
		await t.test(
			"SSL_CERT_FILE=A permits a real loopback metadata GET",
			async () => {
				const result = await view(
					"loopback-a",
					join(directory, "a.crt"),
					loopback,
					"chooser-tls-probe",
				);
				assert.equal(result.code, 0, result.stdout + result.stderr);
				assert.equal(result.stdout.trim(), "1.0.0");
				assert.deepEqual(requests, [
					{ method: "GET", path: "/chooser-tls-probe" },
				]);
			},
		);
		await t.test("unrelated B rejects loopback A", async () => {
			const before = requests.length;
			rejected(
				await view(
					"loopback-b",
					join(directory, "b.crt"),
					loopback,
					"chooser-tls-probe",
				),
			);
			assert.equal(requests.length, before);
		});
		await t.test("curated roots permit public registry metadata", async () => {
			const result = await view(
				"public-curated",
				curated,
				"https://registry.npmjs.org/",
				"is-number@7.0.0",
			);
			assert.equal(result.code, 0, result.stdout + result.stderr);
			assert.equal(result.stdout.trim(), "7.0.0");
		});
		await t.test(
			"unrelated B replaces public roots without ambient root merging",
			async () => {
				rejected(
					await view(
						"public-b",
						join(directory, "b.crt"),
						"https://registry.npmjs.org/",
						"is-number@7.0.0",
					),
				);
			},
		);
	},
);
