# Hephaestus 0.3.0 Alpha

A follow-up to [0.2.3](https://github.com/Ellian-Eorwyn/Hephaestus/releases/tag/v0.2.3). The status bar could tell you a backend answered. It could not tell you anything about the machine answering — how much VRAM was left, whether a card was pinned, which models were actually resident. This release adds that, for anyone running [llm-stack-manager](https://github.com/Ellian-Eorwyn/llm-stack-manager) behind their harnesses.

## 🖥️ New: live LLM stack readout in the status bar

`BACKEND ONLINE` was one boolean, checked once when the app started. It stayed green whether the box was idle or thrashing, and it went on saying the same thing after a model had been evicted or a GPU had filled up.

Next to it there is now a live segment:

```
● LLMS  VRAM 38.7/48G  GPU 0%  25°C
```

VRAM is summed across cards; load and temperature come from the busiest and hottest one, because one saturated GPU is the thing worth knowing about and an average would hide it. The dot carries alert level — amber when the stack is warning about something, so trouble is visible without opening anything.

Clicking opens a panel with the detail: a meter per GPU, the model aliases actually resident on each, service and backend counts, router state, and the stack's own alerts in full. When the stack is unreachable the panel says why, rather than the readout quietly vanishing.

This is **off by default**. It reads an API that only exists if you run llm-stack-manager, so it costs nothing to everyone else — no requests, no config file, nothing in the status bar. Turn it on in **Settings → LLM stack**, where the URL field arrives pre-filled with a guess derived from your harness's own backend host, and a **Test** button checks it before you commit.

### Why it polls

The state API offers a Server-Sent Events stream, which looks like the obvious fit for a live readout. It isn't. `?include=` on that stream filters event *types*, not sections, so every `snapshot` frame stays the full ~23 KB and repeats every two seconds — forever, for three numbers. The `delta` events that would be cheap only fire when services or alerts change, not when GPU metrics move, which is precisely what this shows.

A section-filtered snapshot is ~3 KB on request. Hephaestus polls that every 5 seconds, drops to 30 when the window isn't in front, and stops entirely when the monitor is off.

### Where the token lives

The state API takes an optional bearer token, and warns you when it has none — unauthenticated, anything that can reach the port can read your full stack state. If you set one, it is stored by the main process and never crosses into the UI layer; the settings field reports only that a token exists. A URL that isn't `http` or `https` is refused before it reaches the network.

---

## 🛠️ Installation

Download the pre-compiled binary for your platform from the assets below.

* **Windows:** the `.exe` installer.
* **macOS (Apple Silicon):** `Hephaestus-0.3.0-arm64.dmg`.
* **macOS (Intel):** `Hephaestus-0.3.0.dmg`.
* **Linux:** the `.AppImage`, or the `.deb` on Debian and Ubuntu.

Upgrading from 0.2.3 is a straight replacement — your harnesses, projects, and conversations all live outside the app and are untouched. The new monitor starts off, so nothing changes until you enable it.

## ⚠️ Alpha Notice

This is still an alpha, so you may hit a rough edge. Feedback, bug reports, and feature requests are very welcome on the [GitHub repository](https://github.com/Ellian-Eorwyn/Hephaestus).
