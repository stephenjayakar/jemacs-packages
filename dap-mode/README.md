# dap-mode

An out-of-tree Jemacs port of the GNU Emacs `dap-mode` setup in
`~/.emacs.d/stephen.el`. It uses the Debug Adapter Protocol, automatically
enables `dap-auto-configure-mode`, loads Python support with `debugpy`, and
shows GNU-style Breakpoints, Locals, Expressions, and Debug Sessions windows
when execution stops.

## Python quick start

1. Make `debugpy` importable by `dap-python-executable` (default: `python`).
2. Open a Python file.
3. Run `M-x dap-debug` and select `Python :: Run file (buffer)`.

The package imports GNU dap-mode breakpoints from
`~/.emacs.d/.dap-breakpoints`, including conditions, hit conditions, and log
messages. Jemacs runtime state is stored in `~/.jemacs/dap-state.json`; the GNU
file is never overwritten.

Projects may also provide `.vscode/launch.json` files. JSON-with-comments,
compounds, presentation ordering, inputs, tasks, and VS Code variable
substitution are supported. Node debugging discovers Microsoft's `js-debug`
from installed VS Code/Cursor extensions or `dap-node-adapter-path`.

## GNU command surface

The primary commands keep their GNU names: `dap-debug`, `dap-debug-last`,
`dap-debug-recent`, `dap-debug-restart`, `dap-breakpoint-toggle`,
`dap-breakpoint-add`, `dap-breakpoint-delete`, `dap-breakpoint-condition`,
`dap-breakpoint-hit-condition`, `dap-breakpoint-log-message`, `dap-continue`,
`dap-next`, `dap-step-in`, `dap-step-out`, `dap-disconnect`, `dap-eval`,
`dap-switch-session`, `dap-switch-thread`, `dap-switch-stack-frame`, and the
`dap-ui-*` commands.

As in Stephen's GNU Emacs config, the package does not install extra F-key or
`C-c d` bindings. Use `M-x dap-hydra` for the compact command reminder or bind
the GNU commands in personal config.
