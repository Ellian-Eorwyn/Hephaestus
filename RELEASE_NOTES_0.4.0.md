# Hephaestus 0.4.0 Alpha

A follow-up to [0.3.0](https://github.com/Ellian-Eorwyn/Hephaestus/releases/tag/v0.3.0). This one closes the gap with the terminal on the things you do *mid-conversation*: change how hard the model thinks, answer the menus a harness throws up, and run a command without leaving the chat.

## 🧠 Shift+Tab cycles thinking modes

The pi/forge harness has always had a thinking level — `off` through `high` — but Hephaestus gave you no way to touch it; you were stuck on whatever the harness defaulted to. Now **Shift+Tab** in the composer cycles it, exactly as it does in the terminal, and a **think** chip in the status bar shows the current level (click it to cycle there too).

The level is sticky: set it once and every following message uses it, across restarts. It's pushed to a chat the moment the first message goes out — and it only ever overrides the harness's own default when *you've* actually chosen a level, so a fresh install changes nothing until you press the keys.

## ⌨️ The pop-up menus work now

When a harness — or one of its extensions — stops mid-turn to ask you something (*pick one of these, confirm this, type that*), Hephaestus used to render a row of buttons you could only reach with the mouse. Those prompts are proper menus now: arrow keys move the selection, Enter chooses, Escape cancels, and the sensible default is highlighted. The `input` and `editor` prompts gained Escape-to-cancel and ⌘↩-to-submit, and the status widgets an extension pushes now actually render.

## ⌘ Slash commands, starting with /model

Type `/` in the composer and an autocomplete menu opens — the built-in commands, plus whatever the harness itself exposes. The headline is **`/model`**, which opens a picker and switches the active model without ever leaving Hephaestus; the status bar now shows the model you're actually on, not merely one the backend happens to offer.

It's a framework, not a one-off — this release also wires `/think`, `/compact`, `/new`, `/resume`, `/tree`, `/fork`, `/name`, and `/clone`, and adding another is a single entry in a list.

> **On scope:** a harness's own *built-in* terminal menus (its `/model` picker, `/settings`, and so on) are painted straight to the terminal and never travel over the channel Hephaestus speaks to it — so they can't be shown as-is. The useful ones are rebuilt here natively instead, which is exactly what `/model` and the thinking picker are.

---

## 🛠️ Installation

Download the pre-compiled binary for your platform from the assets below.

* **Windows:** the `.exe` installer (`Hephaestus Setup 0.4.0.exe`).
* **macOS (Apple Silicon):** `Hephaestus-0.4.0-arm64.dmg`.
* **macOS (Intel):** `Hephaestus-0.4.0.dmg`.
* **Linux:** the `.AppImage`, or the `.deb` on Debian and Ubuntu.

Upgrading from 0.3.0 is a straight replacement — your harnesses, projects, and conversations all live outside the app and are untouched.

## ⚠️ Alpha Notice

This is still an alpha, so you may hit a rough edge. Feedback, bug reports, and feature requests are very welcome on the [GitHub repository](https://github.com/Ellian-Eorwyn/Hephaestus).
