# T4 Code nightly on Windows

This local fork contains the checkout-owned terminal changes on public upstream main. The Windows application is named **T4 Code (Nightly)**, with `t4code.exe` and its own Start menu shortcut.

Build from this checkout after installing dependencies with `vp i`:

```powershell
./scripts/build-t4-nightly.ps1
```

The installer is written to `release/t4code`. Run it to install or replace the previous T4 nightly. An explicit version can be supplied with `-Version 0.1.2-nightly.20261025.1`.

T4 stores server data in `%USERPROFILE%/.t4/userdata` and its Electron profile in `%APPDATA%/t4code`. `T4CODE_HOME` overrides its server base directory. Existing T3 data is not imported. The bundled launcher is `%USERPROFILE%/.t4/bin/t4code.cmd`.

The application uses its own app ID and `t4code` URL scheme. These local builds have no automatic update feed; rebuild and rerun the installer when you want to pick up source changes. Builds are unsigned and are not published remotely by this command.
