# Known issues

## Intermittent iOS Files selection

In simulator tests, Files has intermittently remained open after selecting local CSV, JSON, PDF, image, or video files. Both open-in-place and import picker modes can stall, and cancellation has also stalled during investigation. Without a selection or dismissal callback, the request can remain pending and later picker calls can report `BUSY`.

Native FileProvider URL or bookmark resolution errors have been observed in some cases. Failures occurred with RC1, RC2, and a plain UIKit reference app without Cordova or Chooser. Some metadata cases passed with RC1 and failed with RC2 in simulator testing. The cause and impact on physical devices and other providers remain unknown. Import mode is not a verified workaround, and requiring iOS 15 does not establish a fix.

If Files responds, cancel and wait for the request to settle before retrying. An `AbortSignal` requests cancellation through the plugin, but cannot guarantee recovery of an unresponsive system picker. An app restart may be necessary if Files remains stuck.

## Separate investigation coverage

Required CI runs controlled native picker contract tests across Cordova iOS 7 and 8 on iPhone and iPad, independently of Files preparation. Real picker and provider UI cases remain in the manually dispatched **iOS picker investigation** workflow, where setup and all assertions still gate the workflow. This separation does not establish that the issue is fixed or prove real provider UI behavior. The complete local simulator suite remains available. See [verification](VERIFICATION.md#simulator-and-framework-integration) for commands, report handling, and the criteria for returning cases to required CI.

To report a current reproduction, include device or simulator, OS version, provider/location, method/options, and a small nonprivate example. See [reporting guidance](TROUBLESHOOTING.md#report-a-reproducible-issue).
