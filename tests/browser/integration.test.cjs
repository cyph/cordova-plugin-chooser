const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const { resolve, sep, extname } = require("node:path");
const playwright = require(process.env.CHOOSER_PLAYWRIGHT_MODULE);
const root = resolve(process.env.CHOOSER_BROWSER_ROOT);
const bytes = Buffer.from([0, 1, 255, 128, 42]);
const file = (name = "binary.bin", buffer = bytes) => ({
	name,
	mimeType: "application/octet-stream",
	buffer,
});
const image = {
	name: "pixel.png",
	mimeType: "image/png",
	buffer: Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
		"base64",
	),
};
const blobPolicies = {
	blocked: { read: false, preview: false },
	read: { read: true, preview: false },
	preview: { read: false, preview: true },
	allowed: { read: true, preview: true },
};

for (const engine of ["chromium", "firefox", "webkit"]) {
	test(
		`${engine}: packed Cordova bridge, CSP and resource ownership`,
		{ timeout: 90000 },
		async (context) => {
			const server = createServer(async (req, res) => {
				try {
					const request = new URL(req.url, "http://localhost");
					const path = resolve(
						root,
						`.${decodeURIComponent(request.pathname)}`,
					);
					if (!path.startsWith(root + sep)) {
						res.writeHead(403).end();
						return;
					}
					res.setHeader(
						"Content-Type",
						{ ".html": "text/html", ".js": "text/javascript" }[extname(path)] ||
							"application/octet-stream",
					);
					if (extname(path) === ".html") {
						const policy =
							blobPolicies[request.searchParams.get("csp")] ||
							blobPolicies.allowed;
						res.setHeader(
							"Content-Security-Policy",
							`default-src 'self'; connect-src 'self'${policy.read ? " blob:" : ""}; img-src 'self'${policy.preview ? " blob:" : ""}; object-src 'none'; base-uri 'self'`,
						);
					}
					res.end(await readFile(path));
				} catch {
					res.writeHead(404).end();
				}
			});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			let browser;
			try {
				context.signal.addEventListener(
					"abort",
					() => {
						browser?.close().catch(() => {});
					},
					{ once: true },
				);
				browser = await playwright[engine].launch({ headless: true });
				const page = await browser.newPage();
				page.setDefaultTimeout(10000);
				const errors = [];
				page.on("pageerror", (error) => errors.push(error.message));
				const url = `http://127.0.0.1:${server.address().port}/index.html`;
				await page.goto(url);
				await page.waitForFunction(
					() => !document.getElementById("pick").disabled,
				);
				await page.evaluate(() => {
					window.reads = 0;
					window.live = new Set();
					const read = FileReader.prototype.readAsDataURL;
					FileReader.prototype.readAsDataURL = function (file) {
						window.reads++;
						return read.call(this, file);
					};
					const create = URL.createObjectURL.bind(URL),
						revoke = URL.revokeObjectURL.bind(URL);
					URL.createObjectURL = (file) => {
						const uri = create(file);
						live.add(uri);
						return uri;
					};
					URL.revokeObjectURL = (uri) => {
						live.delete(uri);
						revoke(uri);
					};
				});
				async function start(method, options, concurrent = false) {
					await page.evaluate(
						({ method, options, concurrent }) => {
							document.getElementById("pick").onclick = () => {
								// Capture rejection immediately; assertions consume the settled result later.
								window.pending = chooser[method](options).then(
									(value) => ({ value }),
									(error) => ({ error: String(error) }),
								);
								if (concurrent)
									window.second = chooser.getFileMetadata().then(
										(value) => ({ value }),
										(error) => ({ error: String(error) }),
									);
							};
						},
						{ method, options, concurrent },
					);
					const dialog = page.waitForEvent("filechooser");
					await page.click("#pick");
					return dialog;
				}
				const result = () =>
					page.evaluate(async () => {
						const result = await Promise.race([
							pending,
							new Promise((_, reject) =>
								setTimeout(
									() => reject(new Error("Picker did not settle")),
									10000,
								),
							),
						]);
						if (result.value?.data)
							result.value.data = Array.from(result.value.data);
						return result;
					});
				async function release(value) {
					await page.evaluate(async (value) => {
						for (const item of Array.isArray(value) ? value : [value])
							await chooser.releaseFile(item.id);
					}, value);
				}

				let dialog = await start("getFile");
				await dialog.setFiles(file());
				let selected = (await result()).value;
				assert.deepEqual(selected.data, [...bytes]);
				assert.equal(
					selected.dataURI,
					`data:application/octet-stream;base64,${bytes.toString("base64")}`,
				);
				assert.equal(selected.size, bytes.length);
				await release(selected);
				assert.equal(await page.evaluate(() => live.size), 0);

				const reads = await page.evaluate(() => window.reads);
				dialog = await start(
					"getFilesMetadata",
					"application/octet-stream",
					true,
				);
				assert.equal(dialog.isMultiple(), true);
				await dialog.setFiles([
					file("one.bin"),
					file("empty.bin", Buffer.alloc(0)),
				]);
				selected = (await result()).value;
				assert.equal(selected.length, 2);
				assert.equal(selected[1].size, 0);
				assert.equal("data" in selected[0], false);
				assert.match((await page.evaluate(() => second)).error, /^BUSY:/);
				assert.equal(await page.evaluate(() => window.reads), reads);
				await release(selected);

				dialog = await start("getFilesUri", {
					maxTotalSize: bytes.length,
					maxFiles: 2,
				});
				await dialog.setFiles([file(), file("empty.bin", Buffer.alloc(0))]);
				selected = (await result()).value;
				assert.equal(selected.length, 2);
				assert.deepEqual(
					await page.evaluate(
						async (uri) =>
							Array.from(
								new Uint8Array(await (await fetch(uri)).arrayBuffer()),
							),
						selected[0].uri,
					),
					[...bytes],
				);
				assert.equal(await page.evaluate(() => window.reads), reads);
				const uri = selected[0].uri;
				await release(selected);
				assert.equal(
					await page.evaluate(async (uri) => {
						try {
							await fetch(uri);
							return false;
						} catch {
							return true;
						}
					}, uri),
					true,
				);

				dialog = await start("getFilesUri", { maxFileSize: 1 });
				await dialog.setFiles([file("empty.bin", Buffer.alloc(0)), file()]);
				assert.match((await result()).error, /^FILE_TOO_LARGE:/);
				assert.equal(await page.evaluate(() => live.size), 0);

				dialog = await start("getFileMetadata");
				await dialog.setFiles([]);
				assert.equal((await result()).value, undefined); // Empty DOM selection, not an OS cancel-dialog assertion.

				await page.evaluate(() => {
					FileReader.prototype.readAsDataURL = function () {
						queueMicrotask(() =>
							this.dispatchEvent(new ProgressEvent("error")),
						);
					};
				});
				dialog = await start("getFile");
				await dialog.setFiles(file());
				assert.match((await result()).error, /^READ_FAILED:/);
				assert.equal(await page.evaluate(() => live.size), 0);

				dialog = await start("getFileUri");
				await dialog.setFiles(file());
				selected = (await result()).value;
				await page.goto(url);
				await page.waitForFunction(
					() => !document.getElementById("pick").disabled,
				);
				assert.equal(
					await page.evaluate(async (uri) => {
						try {
							await fetch(uri);
							return false;
						} catch {
							return true;
						}
					}, selected.uri),
					true,
				);
				for (const [name, policy] of Object.entries(blobPolicies)) {
					await context.test(`Blob URL CSP: ${name}`, async () => {
						await page.goto(`${url}?csp=${name}`);
						await page.waitForFunction(
							() => !document.getElementById("pick").disabled,
						);
						dialog = await start("getFileUri", "image/png");
						await dialog.setFiles(image);
						const selectedImage = (await result()).value;
						assert.match(selectedImage.uri, /^blob:/);
						try {
							const consumed = await page.evaluate(async (uri) => {
								let data = null;
								try {
									data = Array.from(
										new Uint8Array(await (await fetch(uri)).arrayBuffer()),
									);
								} catch {
									/* A restrictive connect-src rejects this read. */
								}
								const preview = await new Promise((resolve) => {
									const element = new Image();
									const finish = (loaded) => {
										element.remove();
										resolve(loaded);
									};
									element.onload = () => finish(true);
									element.onerror = () => finish(false);
									element.src = uri;
									document.body.appendChild(element);
								});
								return { data, preview };
							}, selectedImage.uri);
							assert.deepEqual(
								consumed.data,
								policy.read ? [...image.buffer] : null,
							);
							assert.equal(consumed.preview, policy.preview);
						} finally {
							await release(selectedImage);
						}
					});
				}
				assert.deepEqual(errors, []);
			} finally {
				if (browser) await browser.close();
				server.closeAllConnections();
				await new Promise((resolve) => server.close(resolve));
			}
		},
	);
}
