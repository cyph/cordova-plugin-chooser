# Known issues

## Intermittent iOS Files selection

In simulator tests, Files has intermittently remained open after selecting a local CSV or PDF. Sometimes cancellation also stalls. When the selection callback does not arrive, the request stays pending and subsequent picker calls can report `BUSY`.

The same selection symptom has been observed in a plain UIKit reference app without Cordova or Chooser. Its cause and impact on physical devices have not been established. There is no verified plugin workaround.

If Files responds, use Cancel and wait for the request to settle before trying again. If it remains unresponsive, an app restart may be necessary. An application timeout does not cancel the native picker.

To report a reproduction, include the device or simulator, OS version, provider and location, method and options, and a small nonprivate example. See [report a reproducible issue](TROUBLESHOOTING.md#report-a-reproducible-issue).
