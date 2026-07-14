# tmux-cc for Jemacs

`tmux-cc` integrates tmux control mode (`tmux -CC`) with Jemacs. Each tmux
pane is rendered by JTerm, while tmux's layout, sessions, windows, and panes
remain controllable from ordinary Jemacs commands and buffers.

Run `M-x tmux-cc-start`. The default command is `tmux -CC attach`; commands
such as `tmux -CC new-session -A -s work` and
`ssh -t host tmux -CC attach` are also supported.

## Pane keys

- `C-tab` / `C-S-tab`: move through Jemacs windows and synchronize tmux focus
- `C-t t`: open the manager
- `C-t 2` / `C-t 3`: split the tmux pane below / right
- `C-t k`: kill the current tmux pane
- `C-t !`: run an arbitrary tmux command
- `C-t c`: create a tmux window
- `C-t S`: create a detached session
- `C-t w` / `C-t s`: switch windows / sessions
- `C-t d`: detach
- `C-c C-t`: toggle JTerm-backed copy mode

Normal Jemacs window commands such as `C-x 2`, `C-x 3`, and `C-x 0` remain
local to Jemacs.

## Manager keys

The `*tmux-control*` manager supports `RET` to visit, `TAB` to preview, `g` to
refresh, `h` or `?` for help, `k` to kill, `n` for a new window, `S` for a new
session, `r` to rename a session, `c` for an arbitrary command, `s`/`w` to
switch, and `d` to detach.

The package is auto-loaded by `jemacs-stephen-config` when this repository is
linked as `~/.jemacs/packages`.
