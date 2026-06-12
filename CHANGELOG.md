# Changelog

All notable changes to **Antigravity AutoRetry** will be documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0] — 2026-06-12

### Added
- 🚀 Initial release of **Antigravity AutoRetry**
- Live countdown in the VS Code status bar (bottom-right)
- One-click toggle — click the status bar item to enable/disable instantly
- Keyboard shortcut `Ctrl+Shift+R` to retry immediately
- Keyboard shortcut `Ctrl+Shift+Alt+R` to toggle the timer on/off
- Smart auto-detection of Antigravity retry commands:
  - `antigravity.retry`
  - `antigravity.retryLastRequest`
  - `antigravity.agent.retry`
  - `antigravity.retryAgent`
  - `workbench.action.chat.retry`
  - `workbench.action.chat.resendRequest`
- Dynamic scan of all registered commands for retry-like names
- User-configurable `autoretry.customCommand` for any VS Code command ID
- Configurable interval via `autoretry.intervalSeconds` (default: 30s)
- Interactive interval setter via Command Palette (`AutoRetry: Set Interval`)
- Timestamped retry log in the **Antigravity AutoRetry** Output Channel
- Auto-start on VS Code launch when `autoretry.enabled` is `true`
- Status bar flash notification on each retry fire

---

## [Unreleased]

### Planned
- Detect Antigravity error state via file system watcher for smarter triggering
- Per-workspace interval configuration
- Retry statistics panel
- Sound notification option on retry
