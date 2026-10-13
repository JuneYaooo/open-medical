# Open Medical Workbench

[English](./README_EN.md) | [中文](./README.md)

**A local patient-management assistant for doctors, on Windows and macOS.** Connect patient status, follow-up tasks, personal knowledge collections, case references and working preferences. Reviewed sources and reusable context make everyday retrieval and preparation more useful over time; this does not automatically train the model.

Use Settings to configure daily doctor reminders through WeChat or a Feishu webhook. The Feishu knowledge bot can search selected, reviewed collections when mentioned in an approved group or messaged in an approved direct chat. It supports isolated follow-up context, source excerpts with citations, and optional answers composed by the configured model. See the [connection guide](docs/doctor-assistant-channels.md).

## Principles

- **Configurable processing.** The desktop server binds to `127.0.0.1`. Choose a local model or an external provider; configured external model and messaging services receive the content needed for the enabled operation.
- **Bring your own model.** Configure any provider — DeepSeek, OpenAI, Anthropic, any OpenAI-compatible endpoint, or a fully offline Ollama/vLLM server — with your own API key. Keys are stored encrypted (AES-256-GCM) in a local vault.
- **You stay in control.** File edits are proposals by default; choose per-task approval, workspace auto-apply, or full authorization. Every applied change keeps an auditable original.

## Desktop app (Windows / macOS)

```bash
npm install
npm run build
npm run package:mac    # → release/Open Medical-darwin-<arch>/Open Medical.app
npm run package:win    # → release/Open Medical-win32-x64/  (run on Windows for correct native modules)
```

The packaged app is a portable folder: double-click to run, or use the bundled installer script (`install-mac.command` / `install-win.cmd`). The agent runtime keeps running in the background (tray icon) so long tasks and scheduled jobs survive a closed window.

## Development

```bash
npm run dev        # web UI at http://127.0.0.1:5173
npm run platform   # generic runtime at http://127.0.0.1:8788
npm test           # node --test test suite
npm run desktop    # Electron shell against the local daemon
```

Requires Node.js ≥ 22.13. Docker is optional (needed only for containerized terminal/office tools).

## License

[MIT](./LICENSE)
