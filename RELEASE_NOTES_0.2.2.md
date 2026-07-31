# Hephaestus 0.2.2 Alpha

A maintenance release for [0.2.1](https://github.com/Ellian-Eorwyn/Hephaestus/releases/tag/v0.2.1). Clickable file links were the headline feature of 0.2.1 and they largely didn't work — this release makes them work. Everything from 0.2.1 still applies; this only changes what's listed below.

## 🔗 Fixed: file links that rendered but opened nothing

The 0.2.1 notes promised that any file the agent mentions becomes a link you can click. In practice two things went wrong, and between them the feature was mostly invisible.

**The links pointed at the wrong file.** When the agent wrote a bare filename — `Forge.tsx` rather than the full path — Hephaestus worked out which file that was, and then threw the answer away and guessed again, landing on a file of that name at the top of your project. Which usually doesn't exist. The link appeared, looked correct, and did nothing when clicked. It now keeps the answer it already had.

Along with that: links written as `file:///path/to/thing` are recognised instead of ignored, a bare filename works when written as a markdown link and not just in prose, and names with no extension at all — `Makefile`, `Dockerfile`, `.gitignore` — resolve when they're in backticks and unambiguous.

**Nothing ever asked the agent to write paths that way.** The whole feature depended on the model happening to name files in a form the app could recognise, and nothing had told it to. Hephaestus now quietly asks, on each message, for file paths written from the project root in backticks. There's a new **Ask for clickable file paths** switch in Settings → Behavior if you'd rather not spend the tokens; it's on by default.

## 📁 Fixed: files created during the conversation weren't linkable

The list of files Hephaestus checks references against was built once, when you opened the project, and never updated. So a file the agent had just written — exactly the one you want to open — went unrecognised in the very reply announcing it, until you hit Refresh.

That list now keeps up as the agent works. It follows the agent's own edits rather than waiting on the filesystem, which matters because file monitoring only descends three folders and most source trees are deeper than that.

## 🔍 Clearer about links it isn't sure of

A path that sits inside your project but that Hephaestus hasn't seen is still clickable — the agent may be naming a file it created a second ago — but it's now drawn faintly, with a dashed underline, and hovering says so. If it turns out not to exist, the preview says the path isn't there rather than claiming the file was deleted, which sent people looking for something that never existed.

## 🌐 New: web links open in your browser

Links to web pages in a reply were completely inert — clicking one did nothing at all. They now open in your default browser, and the real destination is shown on hover, since the text of a link is the agent's to choose and needn't match where it goes. Links that are neither a file nor a web address are now drawn as plain text instead of looking clickable.

---

## 🛠️ Installation

Download the pre-compiled binary for your platform from the assets below.

* **Windows:** the `.exe` installer.
* **macOS (Apple Silicon):** `Hephaestus-0.2.2-arm64.dmg`.
* **macOS (Intel):** `Hephaestus-0.2.2.dmg`.
* **Linux:** the `.AppImage`, or the `.deb` on Debian and Ubuntu.

Upgrading from 0.2.1 is a straight replacement — your harnesses, projects, and conversations all live outside the app and are untouched.

## ⚠️ Alpha Notice

This is still an alpha, so you may hit a rough edge. Feedback, bug reports, and feature requests are very welcome on the [GitHub repository](https://github.com/Ellian-Eorwyn/Hephaestus).
