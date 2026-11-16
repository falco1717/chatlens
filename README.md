# ChatLens

A web UI for every Claude Code / Claude desktop chat on your PC, with Claude built in to search them, answer questions about them, and continue them. It works from your phone too.

- **Browse and search** every chat: full transcripts, tool calls and their output, subagent runs, compaction summaries. Full-text and regex search across all of them.
- **Ask about your chats.** A built-in assistant (Claude Agent SDK) has tools to list, search and read any transcript: "What did I work on this week?", "Where did we leave the migration?", "Which commands did I run against that server?". Its answers link to the exact messages.
- **Continue a chat from anywhere.** Reply inside any chat and it carries on on your PC, in that same session, with its folder, tools and history.
  - If the chat is **open in the Claude desktop app**, your message is relayed into that live window, and the desktop's Claude answers there. Relayed messages count as "from another session", so Claude won't take them as your approval for anything risky. For decisions, tick **Send as me**: ChatLens takes the chat over and your message counts as your own. The desktop window then shows it only after you reopen the chat there.
  - Otherwise, ChatLens resumes the session on the PC (`claude -p --resume`).
- **Live view.** Sessions running on the PC right now are listed at the top with busy/idle status, and an open chat follows new messages as they happen.
- **Connect your Claude account in the app.** Open Settings (the gear) → Claude account and paste a token from `claude setup-token`. ChatLens tests it and keeps it on the server, and never shows it again. No restart is needed.
- **Attach PCs from the web UI.** Settings → PCs → **Add a PC** gives a one-line PowerShell command with a single-use code. Run it on any Windows PC with Node.js and Claude Code. It installs an agent that connects out to ChatLens over HTTPS, so nothing is exposed on that PC. Each PC's chats are labelled and filterable, replies are routed back to the right PC, and removing a PC deletes its synced data and switches its agent off.
- **Mobile first.** Bottom tabs on phones, a slide-over panel on tablets, and an installable web app. Streams survive locked screens and flaky networks: turns run server-side and the page reconnects and replays what it missed.

## How it fits together

```
 PC (Windows)                                     Server (Docker)
 ~/.claude/projects/*.jsonl ──┐                  ┌─ /opt/chatlens/sync  (read-only mirror)
 ~/.claude/sessions/*.json  ──┤  sync agent      │
 desktop app session titles ──┘  (one SSH conn) ─┤  receiver.py ──► ChatLens container ◄── browser
 claude.exe  ◄── jobs: relay / resume ───────────┘  /opt/chatlens/bridge          (behind your auth proxy)
```

- `server.mjs` is the HTTP API and SSE streams. The index lives in memory and parses incrementally (transcripts only grow).
- `lib/agent.mjs` is the assistant: Agent SDK `query()` plus in-process MCP tools over the index.
- `lib/pcrun.mjs` and `lib/relay.mjs` continue a chat on the PC, or relay into an open desktop chat.
- `sync/chatlens-sync.mjs` is the PC-side agent: append-only byte deltas over SSH, live-session publishing, and job execution.
- `sync/receiver.py` is the server side of that SSH channel. It confines writes to its folders.

You can also run it **locally only** on the PC: `node server.mjs`, then open http://127.0.0.1:4477. No server or sync needed.

## Requirements

- Node.js 20+ on the PC, and Claude Code installed and signed in (`claude` at `~/.local/bin`).
- For hosting: a Linux server with Docker, Python 3 and SSH access from the PC (key-based), plus a reverse proxy **with authentication**.

## Run it locally

```bash
npm install
node server.mjs          # or ChatLens.cmd on Windows (opens the browser)
```

It listens on 127.0.0.1 only and uses your existing Claude Code login.

## Host it

1. **Server:** copy the repo to `/opt/chatlens/src`, copy `sync/receiver.py` to `/opt/chatlens/receiver.py`, create `/opt/chatlens/{sync,bridge,data}`, and adapt `deploy/example/compose.yaml` and a proxy route (`deploy/example/traefik-chatlens.yml` is one example). Then `docker compose up -d --build`.
2. **Claude login for the container:** open ChatLens → Settings → Claude account, and paste the token that `claude setup-token` prints on any machine with Claude Code. Alternatively, `deploy/set-claude-token.ps1 -Server you@your-server` writes it to the server's `.env`.
3. **Attach PCs:** open Settings → PCs → **Add a PC** and run the command it shows on each PC. Your proxy must let `/agent/*` through **without** the login page (see the second router in `deploy/example/traefik-chatlens.yml`); the app authenticates each PC with its own token. Alternatively, use the SSH mode: create `%LOCALAPPDATA%\ChatLens\config.json` containing `{"host": "you@your-server"}`, test with `node sync/chatlens-sync.mjs --once`, then start it at logon (a Startup shortcut to `wscript.exe sync\start-sync-hidden.vbs` runs it hidden). Its log is at `%LOCALAPPDATA%\ChatLens\sync.log`.

## Security

**Read this before hosting.** Transcripts contain whatever went through your chats, often including passwords, tokens and keys.

- **Hosted:** always behind an authenticating proxy. The app also refuses unknown `Host` headers (DNS rebinding) and requires a custom header on every API call (CSRF).
- **Full tools** (on by default) gives the assistant a shell and file edits with **no approval prompts**: in the container when hosted, on your PC when continuing a chat there. Turn it off for read-only use.
- **Continuing a chat on the PC** runs Claude in that chat's folder with your login, so standing instructions in the chat's history apply.
- **Relayed messages** arrive in the desktop chat labelled as coming from another session. Claude treats them as relayed rather than typed, so it may ask you to confirm risky actions in the desktop app.
- **Writes are confined:** the sync mirror is mounted read-only in the container, and `receiver.py` only writes inside its two folders.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `CHATLENS_PORT` / `CHATLENS_HOST` | server | Listen port (4477) and address (127.0.0.1 locally, 0.0.0.0 in the image) |
| `CHATLENS_ALLOWED_HOSTS` | server | Extra host names the app answers to (your public name) |
| `CLAUDE_CODE_OAUTH_TOKEN` | container | The container's Claude login (`claude setup-token`). A token saved in Settings (`data/claude-auth.json`, mode 600) takes precedence |
| `CHATLENS_SERVER_NAME`, `CHATLENS_PC_NAME`, `CHATLENS_CONTEXT` | server | Optional wording for messages and the assistant's instructions |
| `CHATLENS_PROJECTS_HOME` | local | Optional: where your projects live, for the assistant's instructions |
| `CHATLENS_SYNC_HOST` / `config.json` `host` | PC | SSH destination of the server (required for sync) |
| `CHATLENS_SYNC_ROOT`, `_RECEIVER`, `_BRIDGE` | PC | Server paths if not under `/opt/chatlens` |

## Limits

- Windows-first: the PC side reads `%APPDATA%\Claude` and uses `tasklist`. The server side is plain Linux.
- The desktop app keeps its own view of an open chat, so ChatLens relays into it. Relayed messages show in the desktop window as Claude's reply opening with a quote of your message.
- Chats are addressed by name for relaying; two open chats with the same name are refused.

## License

MIT
