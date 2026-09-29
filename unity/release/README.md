# Release helpers

`fastlane/Fastfile` holds read-only App Store Connect checks invoked by the GitHub workflows
(`ios-signing.yml`, `testflight.yml`). It never stores credentials; the workflows pass the App Store
Connect API key through environment variables scoped to the `ios-release` GitHub environment.

Release records produced by `testflight.yml` (IPA SHA-256, UBA build number, commit, Apple team,
upload time) are attached to the workflow run as the `testflight-record-<build>` artifact and
summarised on the run page; nothing is written back to the repository.
