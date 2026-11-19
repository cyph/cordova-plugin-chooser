# Cordova Plugin Chooser

Pick documents, photos, and videos in Capacitor or Cordova. This package registers a native Capacitor plugin on Android and iOS and uses a browser picker on the web. Chooser can return metadata, read a small file into JavaScript, or provide a managed file for streaming and native consumers.

For new projects, install `cordova-plugin-chooser@next`. This guide uses the 2.0.0-rc.2 API. Stable 2.0.0 is expected very soon, pending further testing and validation. If you are upgrading an existing app, read the [migration guide](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/MIGRATION.md).

## Installation

<a id="quick-start"></a>

<a id="pick-a-text-file-in-capacitor"></a>

### Install in Capacitor

In an existing Capacitor 8 app, install the package and import its Capacitor entry point.

```sh
npm install cordova-plugin-chooser@next
```

### Install in Cordova

Set the explicit [deployment target](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/PLATFORMS.md#build-configuration) before installing in a Cordova iOS app. From the app directory, run the following commands for the platforms you use.

```sh
cordova plugin add cordova-plugin-chooser@next
cordova prepare
```

### Pick a text file

Add a button and a place to display the result.

```html
<button id="choose-file" type="button" disabled>Choose a text file</button>
<pre id="file-result" role="status"></pre>
```

Load this TypeScript module after those elements exist. The click opens the document picker and shows the filename and decoded text. Adjust the 1 MiB limit for the input your app expects.

```ts
import { Chooser } from 'cordova-plugin-chooser/capacitor';

function start(chooser: typeof import('cordova-plugin-chooser')) {
  const button = document.querySelector<HTMLButtonElement>('#choose-file')!;
  const output = document.querySelector<HTMLElement>('#file-result')!;

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
}

start(Chooser);
```

For Capacitor Android or iOS, build your app's web assets, then sync and run the native app. For a Capacitor web app, use your usual development server or web build.

```sh
npm run build
npx cap sync
npx cap run android
```

Use `npx cap run ios` for iOS. Use TypeScript 5.7 or newer with either framework.

### Pick a text file in Cordova

Load the generated `cordova.js` and use the same HTML. Add this TypeScript module to the app.

```ts
export {};
declare const chooser: typeof import('cordova-plugin-chooser');

document.addEventListener('deviceready', () => {
  const button = document.querySelector<HTMLButtonElement>('#choose-file')!;
  const output = document.querySelector<HTMLElement>('#file-result')!;
  button.disabled = false;
  button.addEventListener('click', async () => {
    try {
      const file = await chooser.getFileData({
        accept: 'text/plain',
        format: 'text',
        maxFileSize: 1024 * 1024
      });
      output.textContent = `${file.name}\n${file.text}`;
    } catch (error) {
      if (!(error instanceof chooser.CancellationError)) {
        output.textContent = error instanceof Error ? error.message : String(error);
      }
    }
  });
});
```

The direct-data method cleans up its temporary resources and keeps the complete decoded text in memory. For large files or a URI, see [file handling](https://github.com/cyph/cordova-plugin-chooser/blob/master/docs/FILE-HANDLING.md).

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
