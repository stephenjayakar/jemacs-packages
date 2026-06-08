# jagent

Native Jemacs coding agent package.

`jagent` runs the agent loop inside Jemacs and uses `jterm` for shell/tool execution. It does not launch a separate agent CLI.

## Commands

- `M-x jagent` opens the dashboard buffer.
- `M-x jagent-dashboard` opens the dashboard without prompting.
- `M-x jagent-ask` prompts Jagent.
- `M-x jagent-ask-buffer` includes the current buffer as context.
- `M-x jagent-ask-region` includes the active region as context.
- `M-x jagent-session-new` opens a Jagent session rooted at another directory.
- `M-x jagent-session-switch` switches between directory sessions.
- `M-x jagent-terminal` shows the managed `*Jagent Terminal*` jterm buffer.

## Keys

- `C-c j` opens Jagent and prompts in the active directory session.
- `C-c j d` opens the dashboard without prompting.
- `C-c j a` asks Jagent.
- `C-c j b` asks with current-buffer context.
- `C-c j r` asks with active-region context.
- `C-c j s` switches sessions.

Inside `*Jagent:project*`: `i`/`RET` asks, `b` asks about a buffer, `s` switches sessions, `n` creates a session, `r` reruns, `a` aborts, `c` clears, `t` opens the terminal, `q` buries.

## Providers

Jagent uses the AI SDK (`ai`) with first-party providers:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

`jagent-provider` can be `auto`, `gemini`, `openai`, `anthropic`, `mock`, or a custom provider name. In `auto`, keys are checked in Gemini, OpenAI, Anthropic order, then usable custom providers.

Defaults:

- `jagent-default-provider` is used when `jagent-provider` is `auto`.
- `jagent-model` overrides the current model.
- `jagent-default-model` is used when no provider-specific default model is configured.

System prompts:

- `jagent-system-prompt` sets a global system prompt.
- `jagent-provider-system-prompts` maps provider names or kinds to prompts.
- `jagent-model-system-prompts` maps `model`, `provider/model`, or `kind/model` to prompts.

Custom providers live in `jagent-custom-providers`:

```ts
{
  "gemini-proxy": {
    kind: "openai-compatible",
    baseURL: "https://gateway.example.com/v1",
    apiKeyEnv: "GEMINI_PROXY_API_KEY",
    defaultModel: "gemini-2.5-pro",
    systemPrompt: "You are Jagent using the Gemini proxy."
  },
  "local-test": {
    kind: "mock",
    defaultModel: "mock",
    mockResponses: ["deterministic test response"]
  }
}
```

## Testing

Use `jagent-provider = "mock"` with `jagent-mock-responses` for deterministic tests. The mock provider uses the AI SDK's `MockLanguageModelV3` from `ai/test`, so calls still go through `generateText` and exercise normal AI SDK tool-call parsing without calling a remote LLM.
