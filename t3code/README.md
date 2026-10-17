# t3code

Starts Claude Code threads in the [T3 Code](https://github.com/pingdotgg/t3code)
desktop app from jemacs. The thread runs in T3 and shows up in its sidebar right
away; jemacs only sends the first prompt. (A jemacs view of the conversation
will come later.)

The thread goes to the T3 project whose workspace root contains the current
buffer's directory (the deepest one if several do). If no project does, you're
asked for a root to add, which defaults to the enclosing git repository.

| Key | Command | |
| --- | --- | --- |
| `C-c T n` | `t3code-new-thread` | Prompt from the minibuffer (`C-u`: choose the project) |
| `C-c T c` | `t3code-compose` | Multi-line prompt buffer: `C-c C-c` sends, `C-c C-k` discards (`C-u`: choose the project) |
| `C-c T r` | `t3code-new-thread-from-region` | Region or whole buffer as the prompt (`C-u`: prefix an instruction) |
| `C-c T o` | `t3code-open-app` | Bring the T3 Code window to the front |

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
