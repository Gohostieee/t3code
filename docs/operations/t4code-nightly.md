# T4 Code nightly on Windows

The `main` branch of [Gohostieee/t3code](https://github.com/Gohostieee/t3code) contains the checkout-owned terminal changes on public upstream main. The Windows application is named **T4 Code (Nightly)**, with `t4code.exe` and its own Start menu shortcut.

## GitHub builds

The [T4 Code nightly workflow](https://github.com/Gohostieee/t3code/actions/workflows/t4code-nightly.yml) builds Windows x64 on pushes to `main`, daily at 07:23 UTC, and through **Run workflow**. It uses GitHub-hosted Windows runners and needs no signing or publishing secrets.

Download the installer artifact from a successful run while signed in to GitHub. Each artifact includes the installer, its SHA-256 checksum, and the exact source commit. Artifacts expire after 30 days. The workflow does not publish GitHub Releases or an automatic update feed.

The fork's Windows workflow is separate from upstream's release and CI infrastructure. Upstream CI jobs require upstream's private runners and run only in `pingdotgg/t3code`.

## Local builds

Build from this checkout after installing dependencies with `vp i`:

```powershell
./scripts/build-t4-nightly.ps1
```

The command builds the Rust resource helper with the installed MSVC toolchain, then uses the packaging pipeline's cached-helper path. Rust, the x64 MSVC tools, Windows SDK, and Python must be installed.

The installer is written to `release/t4code`. Run it to install or replace the previous T4 nightly. An explicit version can be supplied with `-Version 0.1.2-nightly.20261025.1`. Local versions use the current date and seconds since midnight; GitHub versions use the UTC date and workflow run number.

## Installation and state

T4 stores server data in `%USERPROFILE%/.t4/userdata` and its Electron profile in `%APPDATA%/t4code`. `T4CODE_HOME` overrides its server base directory. Existing T3 data is not imported. The bundled launcher is `%USERPROFILE%/.t4/bin/t4code.cmd`.

The application uses its own app ID and `t4code` URL scheme. These local builds have no automatic update feed; rebuild and rerun the installer when you want to pick up source changes. Builds are unsigned and are not published remotely by this command.
