# codex-claude-bridge

Use **Claude models (Opus, Sonnet, Haiku, Fable) inside OpenAI Codex** — the Codex app and the `codex` CLI — next to the GPT models, with your own Claude subscription.

A small local server becomes Codex's model provider. GPT requests are passed through to ChatGPT unchanged; requests for a Claude model are answered by the **official Claude Code CLI**, logged in with your Claude account. Codex keeps doing what it does best: its tools, sandbox, approvals, file edits, skills, MCP apps and sub-agents all keep working, whichever model you pick.

> Unofficial project, not affiliated with Anthropic or OpenAI. Your use of both services remains subject to their terms.

## Features

- **One model menu for everything:** all your GPT models plus the newest Claude model of each family, discovered from your Claude account.
- **Switch models in the middle of a chat:** GPT → Claude → GPT. History, tool calls, images and reasoning summaries are translated in both directions.
- **Sub-agents across vendors:** a Claude model can spawn GPT or Claude sub-agents and the other way round (Codex multi-agent v2).
- **Orchestrator mode:** `Claude Fable … Orchestrator` plans, delegates every coding task to parallel Opus sub-agents and reviews their work (shown when your account offers Fable and Opus; any `<model>-orchestrator` slug works).
- **Fast:** replies stream token by token; a Claude session stays warm between turns so only new messages are sent; system prompt and tools are cached; large tool catalogs are loaded on demand.
- **Full Codex support:** reasoning effort levels (incl. changing them mid-chat), images and screenshots, PDFs and text files, web search (via Claude's own), auto-compaction with real token counts, `/compact`, parallel tool calls.
- **Safe by design:** listens on `127.0.0.1` only and requires a random local key. Claude runs with **no tools of its own**: every command and edit goes through Codex's normal sandbox and approval flow. The bridge never reads Claude's credentials; the official CLI owns login and token refresh.

## Why this instead of claude-codex-proxy?

This project started as a fork of [jpm8888/claude-codex-proxy](https://github.com/jpm8888/claude-codex-proxy), which proved that Claude Code can serve Codex as a Responses provider. Thanks to its author for that groundwork. Building on it, this bridge changes the design in a few fundamental ways (compared with the upstream README as of its last update, September 2026):

| | claude-codex-proxy | codex-claude-bridge |
| --- | --- | --- |
| **GPT and Claude** | Replaces Codex's provider: you use Claude *or* GPT and edit the config to switch | One provider for both: GPT models are passed through to ChatGPT, so all models sit in one menu |
| **Switching models in a chat** | Not possible across providers | GPT ↔ Claude at any point; GPT history (reasoning, tool calls, compaction) is translated. Older chats can be moved over with `migrate-threads` |
| **Who executes actions** | Claude runs with `--dangerously-skip-permissions` and your full Claude Code setup: it can run commands, edit files and use MCP servers **outside Codex's sandbox and approvals** | Claude has no tools of its own and an isolated, empty configuration. Every command and edit is a Codex tool call, so it goes through Codex's sandbox and approvals |
| **Local access** | Optional key, off by default | Random key always required. Browser-origin and non-loopback requests are rejected, and the child process environment is filtered |
| **Streaming** | Text arrives after Claude has finished | Token by token while Claude writes |
| **Session reuse** | Only during one tool loop | A Claude session stays warm across turns (15 min), so only new messages are sent. The system prompt and tools are cached across chats |
| **Context / auto-compaction** | Usage counts only visible content | Real context size and cache hits from Claude, so Codex compacts at the right moment. `/compact` is supported for Claude models |
| **Sub-agents** | — | Codex multi-agent v2: Claude and GPT agents can spawn each other. Orchestrator mode delegates coding to parallel Opus agents |
| **Models** | Fixed aliases (`opus`, `sonnet`, `haiku`, `claude-*`) | Discovered from your account (incl. Fable), with each model's reasoning levels and context window, merged with your GPT models |
| **Images and files** | Browser screenshots only, written to disk temporarily | Images and screenshots as native image blocks in memory; PDFs and text files too |
| **Web search** | Claude's WebSearch disabled | Claude's server-side WebSearch |
| **Under load** | — | Up to 12 parallel sessions; further requests wait for a free slot. Invalid tool calls are corrected inside the session instead of failing the turn |
| **Setup** | Start the server by hand and edit `config.toml` yourself | `install` sets up the login, provider, background service and model menu; `uninstall` restores your previous settings |

## Requirements

- macOS or Linux
- [Codex](https://developers.openai.com/codex) (app or CLI), signed in with ChatGPT
- [Claude Code](https://claude.com/claude-code) CLI and a Claude subscription (Pro or Max)
- [Bun](https://bun.sh) 1.2 or newer and Python 3.8 or newer

## Install

```sh
git clone https://github.com/An0ymOnTelegram/codex-claude-bridge.git
cd codex-claude-bridge
python3 scripts/manage.py install
```

The installer:

1. creates `~/.codex/integrations/claude-subscription/` with a random local key,
2. opens the Claude login in your browser — a separate login used only by the bridge, so your normal Claude Code setup stays untouched,
3. adds the provider `claude_subscription` to `~/.codex/config.toml` (a backup is kept) and makes it the default for new chats,
4. starts a background service (launchd on macOS, a systemd user service on Linux) that starts with your login.

**Restart Codex** and pick a Claude model from the model menu. Keep the cloned folder: the service runs from it.

Options: `--model opus` also makes Opus the default model, `--port 4567` uses another port, `--no-enable` leaves Codex's default provider alone.

### Older chats

Codex ties every chat to the provider it was created with. Chats from before the install can only use GPT models until you run:

```sh
python3 scripts/manage.py migrate-threads   # undo: restore-threads
```

This only changes the provider column in Codex's chat database (a backup is made first). The bridge passes GPT requests through unchanged, so these chats keep working with GPT as before.

## Commands

| Command | |
| --- | --- |
| `install` | Set up login, provider and service (safe to re-run, e.g. after `git pull`) |
| `status` | Claude login, service health and Codex defaults |
| `logs [-f]` | Service log: one metadata line per Claude request, never conversation content |
| `restart` / `stop` / `start` | Control the service. A restart drops warm Claude sessions; the next turn rebuilds them. |
| `enable [--model M]` / `disable` | Make the bridge Codex's default provider / restore your previous defaults |
| `login` | Log the bridge in to Claude again |
| `refresh-models` | Rewrite the model menu (also done automatically on start and every few hours) |
| `migrate-threads` / `restore-threads` | Let older chats use Claude / undo it |
| `serve` | Run the server in the foreground (for debugging, or on systems without launchd/systemd) |
| `uninstall [--purge]` | Remove service and Codex settings and restore your previous defaults. Chats created through the bridge are moved back to `openai`. `--purge` also deletes the bridge's Claude login. |

Run them as `python3 scripts/manage.py <command>`.

## Update

```sh
git pull
python3 scripts/manage.py restart
```

## Configuration

Optional tuning goes into `~/.codex/integrations/claude-subscription/settings.json` under `"env"`, followed by `restart`:

```json
{ "env": { "CLAUDE_ORCHESTRATOR_WORKER": "sonnet" } }
```

| Variable | Default | |
| --- | --- | --- |
| `CLAUDE_ORCHESTRATOR_WORKER` | `opus` | Model the orchestrator delegates coding to |
| `CLAUDE_MAX_WORKERS` | `12` | Claude sessions running at once; further requests wait for a free slot |
| `CLAUDE_SLOT_WAIT_MS` | `600000` | How long a request waits for a free slot |
| `CLAUDE_IDLE_MS` | `900000` | How long a finished session stays warm for the next turn |
| `CLAUDE_MAX_IDLE` | `6` | Warm sessions kept at most |
| `CLAUDE_PROXY_DUMP_DIR` | — | Debugging only: writes every request body, including conversation content, to this folder |

`CODEX_HOME` and `CLAUDE_CODEX_INTEGRATION` (the integration folder) are respected by `manage.py` if you use non-default locations.

## How it works

```
Codex ──► 127.0.0.1:3456/chatgpt ──┬─ GPT model ────► chatgpt.com/backend-api/codex (unchanged)
                                   └─ Claude model ─► claude -p (stream-json, structured output)
```

- Codex sends its ChatGPT login with each request (`requires_openai_auth`). The bridge forwards it to ChatGPT for GPT models and never stores it. The local key travels in its own header, `x-claude-proxy-key`.
- For Claude models, Codex's instructions and tool list become a stable system prompt. Claude answers with a JSON object `{text, tool_calls}`, which the bridge turns back into Responses API events. Codex runs the tools and sends the results in the next request.
- The model menu is a Codex `model_catalog_json`: your GPT models (from Codex's own model list, refreshed through live traffic) followed by the Claude models your account offers.

## Limits

- Claude's thinking is not shown as a reasoning summary; only the reply text streams.
- History that a GPT model compacted remotely is encrypted by OpenAI and cannot be read by Claude; everything after it can.
- OpenAI-hosted tools (image generation, file search, code interpreter) are not offered to Claude models. Remote image/file URLs, OpenAI file IDs, audio and video are described to Claude as unavailable instead of failing the turn.
- No WebSocket transport (`supports_websockets = false`); Codex uses HTTP streaming instead.
- Token counts are estimates for Codex's context management, not billing numbers. Usage limits are those of your Claude plan; depending on the plan, Fable may consume purchased usage credits.
- Codex and Claude Code change quickly. A new version of either can need an update here.

## Troubleshooting

- **Claude models missing from the menu:** restart Codex; check `status` (logged in?) and `logs`.
- **"Not logged in":** `python3 scripts/manage.py login`, then `restart`.
- **"Cannot change this thread's model provider":** the chat was created before the install; run `migrate-threads` and restart Codex.
- **Port in use:** `python3 scripts/manage.py install --port 4567`.

## Development

```sh
bun install --frozen-lockfile
bun run check        # typecheck + tests
```

The tests use a fake `claude` binary and a fake ChatGPT backend; they consume no quota. To debug against a real Codex without touching your service, run a second instance on another port with `CLAUDE_CODEX_INTEGRATION` pointing to a scratch folder and `CLAUDE_PROXY_DUMP_DIR` set.

## Credits

Based on [jpm8888/claude-codex-proxy](https://github.com/jpm8888/claude-codex-proxy) (MIT), extended with the combined ChatGPT + Claude provider, model switching, sub-agents, orchestration, streaming, session reuse, compaction and the installer.

## License

[MIT](LICENSE)
