# SolarClient Launcher

The source code of the SolarClient Minecraft launcher, published so anyone can
read it and see exactly what the launcher does.

**This is not open source.** SolarClient is proprietary software under a
source-available license: you may view the code, but you may not modify it,
reuse any part of it, redistribute it, or sell it. See [`LICENSE`](LICENSE).

- Download: [figgysmp.shop](https://figgysmp.shop) or this repo's
  [Releases](https://github.com/sharktoothgaming56-maker/solarclient-launcher/releases).
- `main` is updated with every published build, stable and beta. Each build is
  tagged `v<version>`, and its release carries the installer built from that
  tag. Beta releases are marked as pre-releases.
- No server credentials or private keys are included. The launcher talks to
  SolarClient's public APIs only.

## Layout

```
src/main/       Electron main process: auth, downloads, Java, launching, mods
src/renderer/   The launcher UI (HTML, CSS, JS)
legal/          Terms and privacy text shown in the app
scripts/        Build helpers
```

Minecraft is a trademark of Mojang Synergies AB. SolarClient is not an official
Minecraft product and is not approved by or associated with Mojang or Microsoft.
