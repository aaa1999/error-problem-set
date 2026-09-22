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
- **Merge data folders**: merge another Error-Notebook data folder (data.json + assets — an old backup, or data from another device) into the current one — items, notes, folders and tags all migrate; folders merge by name, images dedupe by content hash, already-imported items are skipped, safe to re-run
- **Flip browsing**: one item per page, analysis blurred by default (think first, then reveal), arrow keys / swipe navigation, click to zoom images
- **Folder management**: multi-level folder tree in the sidebar (create / rename / delete / add subfolder), browsing a folder includes its subfolders, one-click move for the current item
- **Multiple tags** per item; sidebar tag filtering is multi-select with an AND/OR toggle; folder × tag filters combine, with counts updating live on both sides
- Editing an existing item **auto-saves** ~1s after you stop typing

## Notes (v0.6)

Open the "📝 Notes" tab in the top bar; notes share the same data folder as mistakes (data.json + assets). Notes list on the left (search, excerpts, format badge), editor on the right:

- **Two writing formats**, chosen when creating:
  - **Markdown**: edit / split / preview modes — split view renders **live as you type**; GFM tables and task lists supported; Enter auto-continues list prefixes; toolbar for bold/italic/inline-code/quote
  - **Word rich text**: WYSIWYG toolbar with heading levels, bold/italic/underline/strikethrough, ordered/unordered lists, quote, divider, clear-formatting; paste rich text straight from web pages or Word
- **Images anywhere**: both editors support **pasting screenshots, dropping image files**, and the 📎 file picker; images share the assets folder with mistakes and dedupe by content hash
- **Export**: any note exports to **PDF** (A4 paginated) or **Word document** (.doc with embedded images, opens directly in Word/WPS)
- **Auto-save** ~1s after typing stops, `Ctrl/⌘ + S` to save immediately; unsaved-changes flush on navigation, and a brand-new empty note is discarded instead of written

## Remote sync (v0.7)

The "☁ Sync" button in the top bar pushes the whole library to a self-hosted server (enter `ip:port`, optionally "remember this address", re-enter anytime):

- **Incremental upload**: images are named by content hash — the client first asks the server which images it already has and **uploads only the missing ones**; `data.json` is pushed in full each time (a few KB, instant)
- **Idempotent & resumable**: interrupted syncs resume on retry — already-uploaded images are skipped; safe to repeat anytime
- Optional access token (`X-Sync-Token`); per-image progress with an abort button while syncing
- The server only needs 3 HTTP endpoints — see **[docs/sync-protocol.md](./docs/sync-protocol.md)** for the API spec (curl examples); a zero-dependency Python implementation ships in **[backend/sync_server.py](./backend/sync_server.py)** (deployment guide in [backend/README.md](./backend/README.md)) — one command to start

## Shortcuts (browse mode)

| Key | Action |
|-----|--------|
| `←` / `→` | previous / next item |
| `Space` | show / hide the analysis |
| `E` | edit current item |
| `N` | new item |
| `Ctrl/⌘ + Enter` (entry mode) | save |
| `Ctrl/⌘ + S` (note editing) | save note now |

## Data folder

On first launch you choose a data folder — on Windows the suggested default is the `data` folder next to the executable (**portable mode**: copy the whole program folder to migrate/backup); Documents and custom locations are also offered; macOS defaults to `~/Documents/错题本/`. You can switch it anytime from the top bar. Layout:

```
data folder/
├── data.json      # all items and notes (text + image references)
├── assets/        # image files, named by content hash, auto-deduplicated (shared by mistakes and notes)
└── snapshots/     # rolling history of data.json, last 20 kept
```

- **Backup = copy this folder**; drop it into iCloud/OneDrive for multi-device use
- Saving is atomic (temp file + replace), so a power cut can't corrupt `data.json`
- Deleted something by accident? Older versions live in `snapshots/`

## Notes

- Images are always **copied** into the data folder (content-hash named, duplicates stored once) — moving or deleting the original never affects the notebook
- This is a personal offline tool, so fs/asset permissions are intentionally broad (`**`); tighten the scopes in `src-tauri/capabilities/default.json` if you prefer
- Roadmap (see DESIGN.md): M2 list/search/export, M3 spaced-repetition review
