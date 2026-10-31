# Android client scaffold

The Android project lives in `android/` and contains no third-party runtime libraries. It targets Android API 35 with a minimum API of 26.

## Build

Open `android/` in Android Studio with an installed Android SDK and JDK 17, or run `gradle assembleDebug` from that directory. The repository does not include a Gradle wrapper yet. Install the generated debug APK on a phone connected to the same laptop hotspot.

## Current behavior

- Registers `ACTION_SEND` and `ACTION_SEND_MULTIPLE` handlers for shared content.
- Holds granted `content://` URIs and reads them directly from `ContentResolver` in 4 MiB bounded chunks; it does not copy the source into an app staging directory.
- Discovers the laptop through the local UDP announcement, with a manual host URL field as fallback.
- The Android client does not scan the browser-pairing QR yet; enter the URL and terminal code in the app.
- Pairs with the host's terminal code, displays the verification phrase, and confirms pairing.
- Sends to the selected host receive root after host send approval.
- Prompts on a destination collision and supports keep-both (rename), replace after verification, skip, or cancel.
- Browses the host's shared root after read approval and streams a chosen file to an Android document-provider destination without app staging.

## Not ready for release

The native client has not been built or exercised on a device. Sending requires providers to report file size. Transfers do not have a persistent Android notification or resume after Android process death. Failed downloads attempt to delete the partially created document, subject to provider support. The client uses local HTTP because host TLS is not implemented. Add a persisted transfer service, provider capability handling, full keyboard/screen-reader review, QR scanning/prefill, and verified TLS before publishing.
