# Cordova Plugin Chooser

Let a user pick a document, photo, or video from a Capacitor or Cordova app. Chooser can return metadata, read a small file into JavaScript, or provide a managed file for streaming and native consumers.

For new projects, install `cordova-plugin-chooser@next`. This guide uses the 2.0.0-rc.2 API. Stable 2.0.0 is expected very soon, pending further testing and validation. If you are upgrading an existing app, read the [migration guide](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/MIGRATION.md).

## Installation

<a id="quick-start"></a>

### Pick a text file in Capacitor

Start in an existing Capacitor app with a native platform added. Install the plugin in the app directory.

```sh
npm install cordova-plugin-chooser@next
npm ls cordova-plugin-chooser
```

For iOS, set the native project's deployment target to at least iOS 15 and retain any higher target required by the host or other dependencies. Capacitor does not execute Cordova hooks. The project tests Capacitor Android with controlled emulator responses. Capacitor iOS and Web do not have equivalent coverage, so test your own platforms and providers. See [platform requirements](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/PLATFORMS.md#requirements-and-coverage).

Add elements for the action and result.

```html
<button id="choose-file" type="button" disabled>Choose a text file</button>
<pre id="file-result" role="status"></pre>
```

Load this TypeScript module once the elements exist. The `deviceready` listener enables the button when the bridge is ready, and a click opens the document picker. On success, the page displays the name and decoded text. The 1 MiB input limit is an example. Choose a budget suitable for your app.

```ts
export {}; // Treat this file as a module.
declare const chooser: typeof import('cordova-plugin-chooser');

const button = document.querySelector<HTMLButtonElement>('#choose-file')!;
const output = document.querySelector<HTMLElement>('#file-result')!;

document.addEventListener('deviceready', () => {
  button.disabled = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const file = await chooser.getFileData({
        accept: 'text/plain',
        maxFileSize: 1024 * 1024,
        format: 'text'
      });
      output.textContent = `${file.name}\n${file.text}`;
    } catch (error) {
      if (error instanceof chooser.CancellationError) {
        output.textContent = 'Selection canceled.';
      } else {
        output.textContent = 'Could not read the file.';
        console.error(error);
      }
    } finally {
      button.disabled = false;
    }
  });
});
```

Import or otherwise load the module in your app, then build the web assets before synchronizing them into the native project. Use your app's build command if it differs from this example.

```sh
npm run build
npx cap sync
npx cap ls
npx cap run android
```

Use `npx cap run ios` for an iOS project, or run the synchronized project from its native IDE. Capacitor's [Cordova plugin guide](https://capacitorjs.com/docs/plugins/cordova) explains synchronization.

`declare` describes the injected `chooser` global without importing a runtime module. The bundled types require TypeScript 5.7 or newer. Call the picker directly from a user gesture, especially on browser platforms. The complete text occupies memory and the direct-data method cleans up its temporary resources. For large files or a URI, use the [managed-file guide](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/FILE-HANDLING.md).

### Install in Cordova

Before installing the plugin, Cordova iOS projects must set an explicit deployment target of at least iOS 15. The project is tested in Swift 5 language mode. Follow [iOS configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/PLATFORMS.md#build-configuration). Then install the plugin and prepare the platforms from the Cordova app directory.

```sh
cordova plugin add cordova-plugin-chooser@next
cordova prepare
cordova plugin ls
```

Load the generated `cordova.js`, wait for `deviceready`, and use the same API.

## Choose a method

| Task | Single selection | Multiple selection |
| --- | --- | --- |
| Read complete contents | `getFileData` | `getFilesData` |
| Work with a managed file and release it yourself | `getFile` | `getFiles` |
| Automatically release after a function finishes | `withFile` | `withFiles` |
| Inspect metadata only | `getFileMetadata` | `getFilesMetadata` |

Managed and direct-data selection requires `maxFileSize`. Multiple-file versions also require `maxTotalSize`. A managed file must be released after all readers finish. Metadata and direct-data results do not need release in RC2. Find every option, result, and error in the [API reference](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/API.md).

<a id="documentation"></a>

## More help

- [File handling](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/FILE-HANDLING.md) covers reading, streaming, and resource lifetimes.
- [Platforms](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/PLATFORMS.md) explains requirements, providers, and lifecycle behavior.
- [Migration](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/MIGRATION.md), [troubleshooting](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/TROUBLESHOOTING.md), and [known issues](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/KNOWN-ISSUES.md) help with upgrades and failures.
- [Contributing](https://github.com/cyph/cordova-plugin-chooser/blob/master/CONTRIBUTING.md), [verification](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/VERIFICATION.md), and the [changelog](https://github.com/cyph/cordova-plugin-chooser/blob/master/CHANGELOG.md) cover project maintenance and history.

## License

Apache-2.0. See [LICENSE](https://github.com/cyph/cordova-plugin-chooser/blob/master/LICENSE) and [NOTICE](https://github.com/cyph/cordova-plugin-chooser/blob/master/NOTICE) for licensing and contributor notices.
