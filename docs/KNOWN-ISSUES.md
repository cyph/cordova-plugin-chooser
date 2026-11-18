# Known issues

## Intermittent iOS Files selection

### Symptoms and recovery

In simulator investigations, Files has sometimes remained open after a local document was selected or after dismissal was requested. A pending picker may cause subsequent requests to fail with `BUSY`. CSV, JSON, PDF, image, and video cases have been observed.

If the dialog responds, cancel it and wait for the original request to settle before opening another. An `AbortSignal` asks Chooser to cancel, but cannot guarantee that a stuck system picker will respond. Restarting the app may be necessary when the interface remains unresponsive.

### Evidence and limits

Stalls have occurred in both open-in-place and import modes. Some runs also showed FileProvider URL or bookmark resolution errors in an independent UIKit control without Cordova or Chooser. The cause remains unknown. The available evidence does not establish the impact on physical devices or other providers. Switching picker modes and using iOS 15 are not verified general fixes.

Required CI exercises controlled native picker contracts and a Cordova bridge smoke test across iPhone and iPad with both maintained Cordova iOS families. Real Files and provider UI cases run separately in the manual iOS picker investigation workflow. Their separation does not mean those cases pass or that the issue is resolved. [Verification](VERIFICATION.md#simulator-and-framework-integration) describes the suites and how to interpret their results. Capacitor iOS and Web do not have equivalent integration coverage to Capacitor Android.

When reporting a reproduction, include the device or simulator, OS, provider and location, method and options, and a small nonprivate file. See [reporting guidance](TROUBLESHOOTING.md#report-a-reproducible-issue).

## Separate investigation coverage

The manual provider suite retains its setup and assertions. It is useful evidence for an investigation but does not replace required release qualification. Preserve failures and unstarted cases when reporting results.
