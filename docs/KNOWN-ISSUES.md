# Known issues

## Intermittent iOS Files selection

In simulator tests, Files has intermittently remained open after selecting a local CSV, JSON, or PDF. Cancellation has also stalled during investigation. Without a selection or dismissal callback, the request can remain pending and later picker calls can report `BUSY`.

Native FileProvider URL or bookmark resolution has failed during these selections. The stalled selection symptom also occurs in a plain UIKit reference app without Cordova or Chooser. Their causes and impact on physical devices have not been established. There is no verified plugin workaround, and requiring iOS 15 does not establish a fix.

If Files responds, cancel and wait for the request to settle before retrying. An `AbortSignal` requests cancellation through the plugin, but cannot guarantee recovery of an unresponsive system picker. An app restart may be necessary if Files remains stuck.

## Separate investigation coverage

Seven test/partition combinations remain in the manually dispatched **iOS provider investigation** workflow with their assertions intact:

| Test | Cordova iOS | Device class | Combinations |
| --- | --- | --- | --- |
| UIKit CSV selection | 7 and 8 | iPhone and iPad | 4 |
| UIKit PDF selection | 7 and 8 | iPhone | 2 |
| Chooser CSV selection | 8 | iPad | 1 |

Observations are not limited to these seven combinations; other simulator cases remain in the required main workflow. Isolating these combinations keeps their failures visible without making every push fail for the same unresolved behavior; it does not mark the issue fixed. The complete local simulator suite remains available. See [verification](VERIFICATION.md#simulator-and-framework-integration) for commands, report handling, and the criteria for returning cases to required CI.

To report a current reproduction, include device or simulator, OS version, provider/location, method/options, and a small nonprivate example. See [reporting guidance](TROUBLESHOOTING.md#report-a-reproducible-issue).
