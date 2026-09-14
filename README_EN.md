# Open Medical Workbench

[English](./README_EN.md) | [中文](./README.md)

**A local-first, open-source agent workbench for Windows and macOS.** Open Medical Workbench bundles a general-purpose agent runtime (file tools, sandboxed terminal, sub-agents, MCP client, skills) with a medical domain adapter (patient-note agents, follow-up planning, document drafting) into a desktop app you fully own.

## Principles

- **Local-only.** All data stays on your machine in SQLite. There is no cloud account, no login, no telemetry, and the servers bind to `127.0.0.1` only.
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
