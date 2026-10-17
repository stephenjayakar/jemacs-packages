# t3code

Starts Claude Code threads in the [T3 Code](https://github.com/pingdotgg/t3code)
desktop app from jemacs. The thread runs in T3 and shows up in its sidebar right
away; jemacs only sends the first prompt. (A jemacs view of the conversation
will come later.)

`C-c T` (`t3code-compose`) asks which directory the thread should run in. It
offers the last directory you used, which is kept in
`~/.jemacs/t3code-state.json`. For your first thread it offers the current
buffer's directory. It then opens a prompt buffer: `C-c C-c` starts the thread
and `C-c C-k` discards the prompt.

A T3 thread runs in its project's root. So the thread uses the T3 project rooted
at exactly that directory, and if there isn't one, a project for it is added.

## How it talks to T3

- The server's address comes from `~/.t3/userdata/server-runtime.json`, so
  T3 Code has to be running.
- Requests use T3's HTTP API. Each new thread is two `POST
  /api/orchestration/dispatch` calls, `thread.create` then `thread.turn.start`.
  This is the same pair the web client sends. T3 then generates the thread
  title.
- Auth is a bearer session issued by the CLI that ships inside the app. It runs
  `bin.mjs auth session issue` under the app's Electron binary with
  `ELECTRON_RUN_AS_NODE=1`. The token is cached in
  `~/.jemacs/t3code-token.json` (mode 600) for 30 days, and a new one is issued
  if the server ever rejects it. List or revoke these sessions with the same
  CLI: `auth session list|revoke --base-dir ~/.t3`.

## Model

The provider is always `claudeAgent`. The model comes from the first of these
that is a Claude model:

1. the project's default model in T3
2. T3's global default model
3. `claude-opus-5-5`

`t3code-model` and `t3code-effort` override the model and effort.

Customize: `t3code-model`, `t3code-effort`, `t3code-runtime-mode`
(`full-access` by default, like T3), `t3code-interaction-mode` (`default` or
`plan`), `t3code-raise-app`, `t3code-app-path`, `t3code-base-directory`,
`t3code-token`.
