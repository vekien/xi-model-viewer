# XI Model Viewer on Linux

Both packages are on the [latest release](https://github.com/vekien/xi-model-viewer/releases/latest).

Two packages, self-contained in the same sense the .exe is — the frontend, the
baked lists and the backgrounds live inside the binary either way. Pick by
distro, not by preference:

```
sudo apt install ./xi-model-viewer_<version>_amd64.deb    # Ubuntu, Mint, Pop!_OS, Debian
chmod +x xi-model-viewer_<version>_amd64.AppImage         # everything else, Manjaro included
./xi-model-viewer_<version>_amd64.AppImage
```

The **.deb** is the small one (~20 MB) because it leaves webkit2gtk and gtk3 to
the distro — which is also why it needs a distro that has them: Ubuntu 22.04 and
Mint 21 onwards do. It installs `/usr/bin/xi-model-viewer` and adds the app to
your menu. Install it with `apt`, not `dpkg -i`, so those two get pulled in.

The **AppImage** carries that stack itself, which is what lets it run on Arch and
Manjaro and what makes it ~95 MB. Nothing is installed; delete the file to
uninstall. It mounts itself with FUSE 2, which Ubuntu and Mint stopped shipping
by default:

```
sudo apt install libfuse2      # Ubuntu 22.04, Mint 21
sudo apt install libfuse2t64   # Ubuntu 24.04, Mint 22
```

or sidestep FUSE altogether with `APPIMAGE_EXTRACT_AND_RUN=1 ./xi-model-viewer_*.AppImage`.

Both are built on Ubuntu 22.04 against glibc 2.35, and glibc only promises
compatibility forwards, so they run on 22.04 and anything newer. Audio is the one
thing that is not in the box: the vgmstream baked into the Windows build is a
win32 one, so `.bgw`/`.spw` playback looks for a `vgmstream-cli` on `PATH`
instead (`pacman -S vgmstream`, or build it) — everything else works without it.
