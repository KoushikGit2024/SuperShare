# Android client scaffold

The Android project lives in `android/` and contains no third-party runtime libraries. It targets Android API 35 with a minimum API of 26.

## Build

Open `android/` in Android Studio with an installed Android SDK and JDK 17, or run `gradle assembleDebug` from that directory. The repository does not include a Gradle wrapper yet. Install the generated debug APK on a phone connected to the same laptop hotspot.

## Current behavior

- Registers `ACTION_SEND` and `ACTION_SEND_MULTIPLE` handlers for shared content.
- Holds granted `content://` URIs and reads them directly from `ContentResolver` in 4 MiB bounded chunks; it does not copy the source into an app staging directory.
- Discovers the laptop through the local UDP announcement, with a manual host URL field as fallback.
- Pairs with the host's terminal code, displays the verification phrase, and confirms pairing.
- Sends to the selected host receive root after host send approval.

## Not ready for release

The native client has not been built or exercised on a device. It currently requires providers to report file size, does not receive files, has no persistent Android transfer notification, does not resume following Android process death, and uses local HTTP because host TLS is not implemented. Add a persisted transfer service, provider capability handling, full keyboard/screen-reader review, and verified TLS before publishing.
