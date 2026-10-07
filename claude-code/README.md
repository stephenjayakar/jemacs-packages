# claude-code

Runs the local `claude` CLI inside jemacs, in a jterm buffer per project.
Ported from [claude-code.el](https://github.com/stevemolitor/claude-code.el).

Buffers are named `*claude:~/project/*`. Commands sent from a source buffer go
to the Claude instance for that buffer's project, and start one if none is running.

| Key | Command | |
| --- | --- | --- |
| `C-c c c` | `claude-code` | Start in project root (`C-u`: pick directory) |
| `C-c c d` | `claude-code-start-in-directory` | |
| `C-c c C` / `R` | `claude-code-continue` / `-resume` | `--continue` / `--resume` |
| `C-c c i` | `claude-code-new-instance` | Extra named instance for the project |
| `C-c c k` / `K` | `claude-code-kill` / `-kill-all` | |
| `C-c c t` | `claude-code-toggle` | Show/hide the Claude window |
| `C-c c b` / `B` | `claude-code-switch-to-buffer` / `-select-buffer` | |
| `C-c c z` | `claude-code-toggle-read-only-mode` | jterm copy mode for scrolling/copying |
| `C-c c s` | `claude-code-send-command` | Prompt from the minibuffer |
| `C-c c x` | `claude-code-send-command-with-context` | Adds `@file#Lline` (or region lines) |
| `C-c c r` | `claude-code-send-region` | Region or whole buffer (`C-u`: add instruction) |
| `C-c c o` | `claude-code-send-buffer-file` | Insert `@file` (`C-u`: add instruction and submit) |
| `C-c c e` | `claude-code-fix-error-at-point` | Sends LSP/flymake diagnostics on the line |
| `C-c c /` | `claude-code-slash-commands` | |
| `C-c c y` / `n` | `claude-code-send-return` / `-escape` | Accept / reject |
| `C-c c 1` `2` `3` | `claude-code-send-N` | Pick a numbered option |
| `C-c c M` | `claude-code-cycle-mode` | S-TAB: default / auto-accept / plan |
| `C-c c f` | `claude-code-fork` | ESC ESC |
| `C-c c m` | `claude-code-transient` | Menu of all of the above |

Inside the Claude buffer every key goes to the CLI. jterm's `C-c` escapes still
work there: `C-c C-t` for copy mode, `C-c C-k` to kill.

Customize: `claude-code-program`, `claude-code-program-switches` (e.g.
`--dangerously-skip-permissions`), `claude-code-submit-delay`,
`claude-code-startup-timeout`, `claude-code-toggle-auto-select`.
