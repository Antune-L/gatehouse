# Releasing Gatehouse

How a new version is built and published. Releases are unsigned (no Apple
Developer ID): the CI produces `.dmg` files attached to a GitHub release, and
users clear the Gatekeeper quarantine flag once after installing (see the
Install section of the README).

## Cut a release

```bash
npm run bump -- patch        # or minor | major | x.y.z
git commit -am "chore: vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

`npm run bump` keeps the version identical in all five places that carry it —
`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — and fails if they already
diverge. Always bump before tagging: the CI names the release after the
version in `tauri.conf.json`, not after the pushed tag.

## What the CI does

Pushing a `v*` tag triggers `.github/workflows/release.yml`:

1. Builds the app on two native runners — `macos-latest` (Apple Silicon) and
   `macos-15-intel` (Intel). Native runners are required: the `gatehouse-mcp`
   sidecar binary is named after the host triple, so cross-compiling with
   `--target` would break the bundle.
2. Runs the full Tauri build (`npm run build`, sidecar, `.app` + `.dmg`).
3. Creates (or updates) a **draft** GitHub release `vX.Y.Z` and uploads
   `Gatehouse_X.Y.Z_aarch64.dmg` and `Gatehouse_X.Y.Z_x64.dmg`.

## Publish

1. Open the draft in the repository's **Releases** tab.
2. Check that both `.dmg` files are attached and named as expected.
3. Edit the release notes (the install instructions are pre-filled), then
   **Publish**.

## Known limitations

- **Unsigned builds.** Gatekeeper blocks the app on first launch; users must
  run `xattr -dr com.apple.quarantine /Applications/Gatehouse.app` once.
  Proper signing + notarization requires an Apple Developer account.
- **Keychain prompt on every update.** The ad hoc signature changes with each
  build, so macOS re-asks permission to access the Gatehouse master key in the
  Keychain after each installed update.
- **Intel runner lifetime.** The `macos-15-intel` label is available until
  August 2027; after that, GitHub Actions drops x86_64 macOS entirely.
