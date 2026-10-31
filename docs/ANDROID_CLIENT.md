# Android client scaffold

The Android project lives in `android/` and contains no third-party runtime libraries. It targets Android API 35 with a minimum API of 26.

## Build

Open `android/` in Android Studio with an installed Android SDK and JDK 17, or run `gradle assembleDebug` from that directory. The repository does not include a Gradle wrapper yet. Install the generated debug APK on a phone connected to the same laptop hotspot.

## Current behavior

- Registers `ACTION_SEND` and `ACTION_SEND_MULTIPLE` handlers for shared content.
- Holds granted `content://` URIs and reads them directly from `ContentResolver` in 4 MiB bounded chunks; it does not copy the source into an app staging directory.
- Requests persistable read access for document-picker selections where the provider supports it, so an interrupted upload can be resumed after reopening the same source.
- Discovers the laptop through the local UDP announcement, with a manual host URL field as fallback.
- The Android client does not scan the browser-pairing QR yet; enter the URL and terminal code in the app.
- For HTTPS, compare the CA fingerprint field against the fingerprint printed in the host terminal. The app pins the CA certificate and verifies the host address against its certificate SAN.
- Pairs with the host's terminal code, displays the verification phrase, and confirms pairing.
- Sends to the selected host receive root after host send approval.
- Prompts on a destination collision and supports keep-both (rename), replace after verification, skip, or cancel.
- Browses the host's shared root after read approval and streams a chosen file to an Android document-provider destination without app staging.
- Shows a foreground transfer notification while sending or receiving. Notification progress refresh is limited to roughly once per second.

## Not ready for release

The native client has not been built or exercised on a device. Sending requires providers to report file size. Upload resume requires reopening the same content URI; Android process death does not automatically restart the transfer. Download resume is not implemented. Failed downloads attempt to delete the partially created document, subject to provider support. Review Android 13+ notification permission behavior, provider capability handling, accessibility, and QR scanning/prefill before publishing.
