# Hephaestus 0.2.1 Alpha

A maintenance release for [0.2.0](https://github.com/Ellian-Eorwyn/Hephaestus/releases/tag/v0.2.0), fixing a hard freeze, adding clickable file links in the chat, and tidying up the icons throughout. Everything from 0.2.0 still applies — this only changes what's listed below.

## 🧊 Fixed: the app froze when you switched chats

The biggest one. Opening a conversation made Hephaestus walk the project folder eight levels deep, all at once, before it would show you anything. For an ordinary code project that was fine. For a project rooted somewhere large — your home folder, a whole drive, a Google Drive or iCloud folder — it never finished: nearly 400,000 files in the first 16 seconds and still going, on the same thread that keeps the window alive. The app locked up completely and had to be force-quit.

The file tree is now loaded one folder at a time, and a folder's contents are read when you actually open it. The same home-folder project that used to hang now lists in about a millisecond. Folders too large to monitor for live changes say so plainly instead of silently doing nothing.

Two related annoyances went with it: a conversation that was slow or failed to load used to leave the *previous* one on screen underneath the newly-highlighted row, which looked like the chat had gone missing; and a chat whose file couldn't be read would spin forever instead of telling you why.

## 🔗 New: click any file the agent mentions

When the agent refers to a file, that reference is now a link. Click it and the file is revealed in the tree — opening every folder along the way — selected, and shown in the preview pane.

This works for files named any of the four ways agents actually write them: as a markdown link, in `backticks`, plainly in a sentence, and as the path in an `edit`/`read`/`write` tool call. A reference like `src/main/index.ts:42` opens the file scrolled to line 42. Filenames that don't correspond to a real file in your project are left as ordinary text, so prose doesn't sprout links it shouldn't have.

## 🎨 Fixed: icons that were the wrong size or missing entirely

Icons beside files and chats would render squashed, or vanish, depending on how long the name next to them was. Long file names and long conversation titles were squeezing them out of the row. Icons now hold their size and the text ellipsizes instead.

While fixing that: all icons now come from one size scale rather than being picked per-place, the large glyphs on empty screens render at their intended size instead of shrinking to a third of it, and the hammer beside the agent's replies no longer changes size when a turn starts and finishes. It also follows the light and dark themes properly now, which it never did.

## 🩺 Better reporting when something does go wrong

A freeze or a renderer crash used to leave nothing behind to look at. Both are now recorded to the app log, and an interface error shows what happened instead of a blank window.

---

## 📦 What landed in 0.2.0, if you're coming from 0.1.0

The 0.2.0 notes described what Hephaestus *is* rather than what had changed, so here's the actual history for anyone upgrading from 0.1.0.

**Streaming got roughly a thousand times cheaper.** The app was doing more work per token than it had any business doing — over a second of CPU per second of streaming, which is why replies stuttered. Stream activity is now batched into one update per frame instead of one per line of output, session files are parsed incrementally from where they left off rather than re-read whole, and a long reply re-parses only the paragraph currently being written instead of the entire message each time. Measured against a real 57 MB conversation library, main-process work per second of streaming went from 3313 ms to 2 ms.

**The file pane became live.** It never actually refreshed itself before: the preview showed whatever the file contained at the moment you clicked it. Now an open file reloads within about 180 ms of a change, tree rows flash when the agent writes to them, and deleting the open file keeps its last contents on screen with a notice instead of blanking.

**File watching worked in development but was dead in every released build.** A native dependency was being bundled in a way that stopped it loading, so shipped `.dmg`s silently never watched anything. Fixed, and the main bundle dropped from 904 KB to 65 KB along the way.

**Harnesses can be installed from inside the app.** The Add Harness dialog gained one-click install cards for `pi-forge`, `pi-vault` and base `pi`, existing installations are discovered automatically at launch, and base `pi` is properly supported — including its global CLI and its hosted login backend, which has no local model config to check.

**The agent can ask you questions mid-turn.** When a harness extension needs a choice, a confirmation, or some text, it now appears as a card in the conversation and the turn resumes on your answer. Previously those requests were dropped and the turn simply hung forever.

**The composer stays usable while the agent works.** Enter queues a follow-up, ⌘Enter steers the current turn. Before, sending mid-stream silently lost your message. Compaction, automatic retries with a countdown, and an unresponsive harness are all visible states now rather than an apparent hang.

**Stopping a turn actually stops it,** escalating until the process gives way, and idle harness processes are cleaned up instead of lingering until you quit.

**Packaging was fixed.** Released builds had been Apple Silicon only — Intel Macs had nothing to run — and no `.deb` had ever been produced at all, because the build refused to make one without a maintainer field. Both fixed, along with the Linux desktop entry so a running window associates with its launcher icon.

Smaller things: session cost is displayed (it was being calculated and never shown), throughput figures come from the provider when it reports them and are otherwise marked as estimates, and Obsidian `[[wikilinks]]` render properly.

---

## 🛠️ Installation

Download the pre-compiled binary for your platform from the assets below.

* **Windows:** the `.exe` installer.
* **macOS (Apple Silicon):** `Hephaestus-0.2.1-arm64.dmg`.
* **macOS (Intel):** `Hephaestus-0.2.1.dmg`.
* **Linux:** the `.AppImage`, or the `.deb` on Debian and Ubuntu.

Upgrading from 0.2.0 is a straight replacement — your harnesses, projects, and conversations all live outside the app and are untouched.

## ⚠️ Alpha Notice

This is still an alpha, so you may hit a rough edge. Feedback, bug reports, and feature requests are very welcome on the [GitHub repository](https://github.com/Ellian-Eorwyn/Hephaestus).
