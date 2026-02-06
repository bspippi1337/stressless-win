# CI builds (Windows + Android)

Workflows live in `.github/workflows/`.

## build-all.yml
- Builds Windows portable on `windows-latest`
- Builds Android APK on `ubuntu-latest` **only if** an Android project exists in:
  - `apps/android/` or `android/`

Artifacts:
- `Stressless-portable-windows`
- `Stressless-android-apk` (when present)

## Tags
Pushing a tag like `v0.1.0-alpha` triggers builds.
