# t3code

Starts Claude Code or Antigravity (`agy`) threads in the
[T3 Code](https://github.com/pingdotgg/t3code) desktop app from jemacs. The
thread runs in T3 and shows up in its sidebar right away; jemacs only sends the
first prompt.

- `C-c T` (`t3code-compose`) asks which directory the thread should run in
  (defaulting to the last one used, kept in `~/.jemacs/t3code-state.json`, or
  the current buffer's directory), then opens a prompt buffer. With `C-u`, it
  first asks which provider (`agy` or `claude`) to use.
- `C-c A` (`t3code-compose-agy`) does the same, targeting Antigravity (`agy`,
  `gemini-4-carbon` by default).
- In the prompt buffer: `C-c C-c` starts the thread, `C-c C-p` switches the
  buffer between `claude` and `agy`, and `C-c C-k` discards the prompt.

A T3 thread runs in its project's root. So the thread uses the T3 project rooted
at exactly that directory, and if there isn't one, a project for it is added.

## How it talks to T3

- The server's address comes from `~/.t3/userdata/server-runtime.json`, so
  T3 Code has to be running.
- Projects use `GET /api/projects` and `POST /api/projects/mutate`; threads are
  launched over T3's v2 WebSocket RPC (`orchestration.launchThread`) using a
  short-lived ticket from `POST /api/auth/websocket-ticket/rpc`.
- Auth is a bearer session issued by the CLI that ships inside the app. It runs
  `bin.mjs auth session issue` under the app's Electron binary with
  `ELECTRON_RUN_AS_NODE=1`. The token is cached in
  `~/.jemacs/t3code-token.json` (mode 600) for 30 days, and a new one is issued
  if the server ever rejects it. List or revoke these sessions with the same
  CLI: `auth session list|revoke --base-dir ~/.t3`.

## Provider & Model

Supported providers:

- `claudeAgent` (`claude`) — defaults to the project's or T3's default Claude
  model, else `claude-opus-5-5` (reasoning option `effort`).
- `antigravity` (`agy`) — defaults to the project's or T3's default Antigravity
  model, else `gemini-4-carbon` (reasoning option `thought_level`). Make sure
  Antigravity is enabled in `~/.t3/userdata/settings.json` (with `binaryPath`
  pointing to `agy` when using the Antigravity CLI).

Customize: `t3code-provider`, `t3code-model`, `t3code-agy-model`,
`t3code-effort`, `t3code-runtime-mode` (`full-access` by default, like T3),
`t3code-interaction-mode` (`default` or `plan`), `t3code-raise-app`,
`t3code-app-path`, `t3code-base-directory`, `t3code-token`.
