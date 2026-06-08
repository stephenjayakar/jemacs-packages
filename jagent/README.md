# jagent

Native Jemacs coding agent package.

`jagent` runs the agent loop inside Jemacs and uses `jterm` for shell/tool execution. It does not launch a separate agent CLI.

## Commands

- `M-x jagent` opens the dashboard buffer.
- `M-x jagent-ask` prompts Jagent.
- `M-x jagent-ask-buffer` includes the current buffer as context.
- `M-x jagent-ask-region` includes the active region as context.
- `M-x jagent-terminal` shows the managed `*Jagent Terminal*` jterm buffer.

## Keys

- `C-c j` opens `*Jagent*`.
- `C-c j a` asks Jagent.
- `C-c j b` asks with current-buffer context.
- `C-c j r` asks with active-region context.

Inside `*Jagent*`: `i`/`RET` asks, `b` asks about a buffer, `r` reruns, `a` aborts, `c` clears, `t` opens the terminal, `q` buries.

## Providers

Jagent uses the AI SDK (`ai`) with first-party providers:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

`jagent-provider` can be `auto`, `gemini`, `openai`, or `anthropic`. In `auto`, keys are checked in that order. `jagent-model` is optional; empty uses a provider default.
