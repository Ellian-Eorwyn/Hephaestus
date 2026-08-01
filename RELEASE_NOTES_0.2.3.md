# Hephaestus 0.2.3 Alpha

A follow-up to [0.2.2](https://github.com/Ellian-Eorwyn/Hephaestus/releases/tag/v0.2.2). Clickable file links worked in code projects but not in note vaults — anywhere filenames contain spaces, which is most places. This fixes that, makes Obsidian `[[wikilinks]]` open the note they name, and adds a version readout to Settings.

## 📝 Fixed: file links did nothing when filenames contain spaces

0.2.2 started asking the agent to name files as paths in backticks, and it did. Then every one of them was refused, because the check behind file links rejected any reference containing a space — and, underneath that, matched only a narrow set of characters that excluded spaces and dashes alike.

For a code project that mostly went unnoticed. For a folder of notes it meant nothing ever linked: a path like `08 Directory/8.01 People — Contacts/Gillian Eorwyn.md` is an ordinary note, and it never stood a chance. Linking had in fact never worked in a vault — 0.2.2 only made the failure complete, by getting the agent to reliably write the one form that was reliably refused.

A path in backticks is now checked against the files your project actually contains rather than against a pattern. That is both a stricter test and a far more permissive one: spaces, dashes, numbered folders and names with no extension at all (`Makefile`, `.gitignore`) resolve, while a backticked `npm run dev` still resolves to nothing and stays code. Paths written in ordinary prose, with no backticks to mark where they begin and end, keep the stricter old rule.

## 🔗 New: `[[wikilinks]]` open the note

In a vault, a wikilink is how you refer to a note — and it was the one form Hephaestus deliberately did nothing with. Clicking one now opens that note in the preview. Aliases (`[[Note|shown text]]`) work, and a `#heading` in the target is ignored rather than breaking the match. A wikilink pointing at a note that doesn't exist yet still renders as a wikilink, because in Obsidian that's a note you haven't written, not a broken link.

## 🏷️ New: which version am I running?

Settings now ends with an **About** section naming the running build — Hephaestus's own version, plus Electron and Chromium. Previously there was no way to tell from inside the app whether a fix had actually reached the copy you were using.

Underneath it is the number of files indexed for the open project, because that single number decides whether file links can work at all: with nothing indexed there is nothing to check a reference against, and every path stays plain text no matter how well everything else behaves.

## 🗂️ Fixed: links to folders

Folders were being treated as linkable. With the more permissive matching above, a reference to `00 Inbox` or `src` would have become a link that opened nothing, since the preview shows files.

---

## 🛠️ Installation

Download the pre-compiled binary for your platform from the assets below.

* **Windows:** the `.exe` installer.
* **macOS (Apple Silicon):** `Hephaestus-0.2.3-arm64.dmg`.
* **macOS (Intel):** `Hephaestus-0.2.3.dmg`.
* **Linux:** the `.AppImage`, or the `.deb` on Debian and Ubuntu.

Upgrading from 0.2.2 is a straight replacement — your harnesses, projects, and conversations all live outside the app and are untouched.

## ⚠️ Alpha Notice

This is still an alpha, so you may hit a rough edge. Feedback, bug reports, and feature requests are very welcome on the [GitHub repository](https://github.com/Ellian-Eorwyn/Hephaestus).
