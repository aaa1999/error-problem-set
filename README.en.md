# Error Notebook (错题本)

**中文版 | [English](./README.en.md)**

A standalone, offline, cross-platform mistake notebook: each item pairs a **question** with its **analysis/solution**, supports mixed text and images, and is reviewed one item per page in a flip-through mode. Everything runs locally — no account, no network.

Tech stack: **Tauri 2 + React + TypeScript + Vite**. Design document (Chinese): [DESIGN.md](./DESIGN.md).

## Run & Build

```bash
npm install          # install frontend dependencies
npm run tauri dev    # dev mode with hot reload
npm run tauri build  # package installers (macOS .app/.dmg, Windows .msi/.exe, Linux .deb/AppImage)
```

Artifacts land in `src-tauri/target/release/bundle/`.

Prerequisites: Node.js ≥ 18, Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`).

### Building on Windows

1. [Node.js ≥ 18](https://nodejs.org/)
2. [Rust (MSVC toolchain)](https://rustup.rs/) — the default `stable-x86_64-pc-windows-msvc`
3. [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload
4. WebView2 Runtime (usually preinstalled on Windows 10/11)

Then run `npm install && npm run tauri build`. Outputs:

- `nsis/…-setup.exe` — **recommended**. Installs into a writable per-user directory, so the "install directory" portable data mode works out of the box.
- `msi/….msi` — installs into `Program Files`, which is not writable; pick the Documents folder (or a custom one) as the data directory.

## Features

- **Entry**: separate text+image editors for question and analysis; insert as many images as you like, laid out in insertion order (hover an image to reorder ↑↓ or delete ✕)
- **Five ways to import images**: paste screenshots from the clipboard (multiple at once) · drag & drop files · 📎 file dialog (multi-select, keeps selection order) · type/paste paths (multiple, comma/newline separated) · paste image files copied from Finder/Explorer
- **Batch import**: recursively scan a folder, natural-sorted by filename; each image becomes a new question or an "analysis ↩" merged into the previous question *of the same folder*; by default subfolders are auto-created mirroring the source structure (or assign a target folder per group); apply one set of tags to everything
- **Merge data folders**: merge another Error-Notebook data folder (data.json + assets — an old backup, or data from another device) into the current one — items, folders and tags all migrate; folders merge by name, images dedupe by content hash, already-imported items are skipped, safe to re-run
- **Flip browsing**: one item per page, analysis blurred by default (think first, then reveal), arrow keys / swipe navigation, click to zoom images
- **Folder management**: multi-level folder tree in the sidebar (create / rename / delete / add subfolder), browsing a folder includes its subfolders, one-click move for the current item
- **Multiple tags** per item; sidebar tag filtering is multi-select with an AND/OR toggle; folder × tag filters combine, with counts updating live on both sides
- Editing an existing item **auto-saves** ~1s after you stop typing

## Shortcuts (browse mode)

| Key | Action |
|-----|--------|
| `←` / `→` | previous / next item |
| `Space` | show / hide the analysis |
| `E` | edit current item |
| `N` | new item |
| `Ctrl/⌘ + Enter` (entry mode) | save |

## Data folder

On first launch you choose a data folder — on Windows the suggested default is the `data` folder next to the executable (**portable mode**: copy the whole program folder to migrate/backup); Documents and custom locations are also offered; macOS defaults to `~/Documents/错题本/`. You can switch it anytime from the top bar. Layout:

```
data folder/
├── data.json      # all items (text + image references)
├── assets/        # image files, named by content hash, auto-deduplicated
└── snapshots/     # rolling history of data.json, last 20 kept
```

- **Backup = copy this folder**; drop it into iCloud/OneDrive for multi-device use
- Saving is atomic (temp file + replace), so a power cut can't corrupt `data.json`
- Deleted something by accident? Older versions live in `snapshots/`

## Notes

- Images are always **copied** into the data folder (content-hash named, duplicates stored once) — moving or deleting the original never affects the notebook
- This is a personal offline tool, so fs/asset permissions are intentionally broad (`**`); tighten the scopes in `src-tauri/capabilities/default.json` if you prefer
- Roadmap (see DESIGN.md): M2 list/search/export, M3 spaced-repetition review
