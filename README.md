# jemacs-packages

Experimental jemacs plugins not yet upstreamed. Each package is a directory with `index.ts` exporting `install(editor)`.

Loaded automatically by `jemacs-stephen-config` from `~/.jemacs/packages/`.

Install this checkout independently of the core and config:

```bash
./scripts/install.sh
```

The script links this repository at `~/.jemacs/packages`, links
`node_modules/@jemacs/core` to the globally installed core at
`${XDG_DATA_HOME:-~/.local/share}/jemacs`, and runs checks. Set `JEMACS_HOME`
when developing against a different core checkout.

## Getting Started With Packages

A package is just a directory under this repo:

```text
jemacs-packages/
  my-package/
    index.ts
```

`index.ts` must export an `install` function. The config loader imports packages alphabetically from `~/.jemacs/packages/<name>/index.ts`, so install once, restart `jemacs`, and the linked checkout is what gets loaded.

Start with the smallest useful package:

```ts
import type { Editor } from "@jemacs/core"

export function install(editor: Editor): void {
  editor.command("my-package-hello", ({ editor }) => {
    editor.message("hello from my-package")
  }, "Say hello from my-package.")

  editor.defineKey("global", "C-c m h", "my-package-hello")
}
```

Restart `jemacs`, then run `M-x my-package-hello` or press `C-c m h`.

## Package Shape

Keep `index.ts` as the public entry point. For anything bigger than one screen, move implementation into sibling files and re-export from `index.ts`:

```ts
export { install } from "./my-package"
export { usefulHelperForTests } from "./my-package"
```

This is the pattern used by `projectile/` and `file-sidebar/`. It keeps the loader simple while letting tests import pure helpers directly.

## Importing Jemacs APIs

Packages use the public core package for both types and runtime APIs:

```ts
import type { BufferModel, Editor } from "@jemacs/core"
import { defineMinorMode, Keymap } from "@jemacs/core"
```

For a built-in plugin that is not part of the public core API, resolve it from
`JEMACS_HOME`; `core-path.ts` provides the canonical global fallback.

## Commands And Keys

Use command names that are globally unique and package-prefixed:

```ts
editor.command("my-package-do-thing", async ({ editor, buffer, prefixArgument }) => {
  editor.message(`Buffer is ${buffer.name}; prefix is ${prefixArgument ?? "none"}`)
}, "Do the package thing.")
```

Bind keys with `editor.defineKey(map, sequence, command)`. `global` and `global-map` are equivalent:

```ts
editor.defineKey("global", "C-c m d", "my-package-do-thing")
```

Mode and minor-mode maps are named after the mode:

```ts
editor.defineKey("my-mode", "RET", "my-package-open")
editor.defineKey("my-minor-mode", "C-c x", "my-package-toggle")
```

## Minor Modes

For a toggleable package, define a minor mode. Use a package-prefixed mode name and a short lighter:

```ts
import { defineMinorMode, Keymap } from "@jemacs/core"

export async function install(editor: Editor): Promise<void> {
  const keymap = new Keymap("my-package-mode-map")
  keymap.bind("C-c m x", "my-package-do-thing")

  defineMinorMode({
    name: "my-package-mode",
    lighter: " MyPkg",
    global: true,
    keymap,
  })
}
```

After install, users can run `M-x my-package-mode`, or config can call:

```ts
editor.enableMinorMode("my-package-mode")
```

## State

Use the smallest state mechanism that matches the lifetime:

- Per-buffer state: `buffer.locals`.
- Per-editor state: `WeakMap<Editor, State>`.
- User options: `defcustom` / `getCustom` from `src/runtime/custom.ts`.
- Avoid module-level mutable state unless it is intentionally process-wide and safe across reloads.

Example:

```ts
const stateByEditor = new WeakMap<Editor, { count: number }>()

function state(editor: Editor): { count: number } {
  let state = stateByEditor.get(editor)
  if (!state) {
    state = { count: 0 }
    stateByEditor.set(editor, state)
  }
  return state
}
```

## Reloading While Developing

There are two useful reload paths:

- Open the package `index.ts` in jemacs and run `C-c C-r` (`reload-current-file`).
- Run `C-c C-l` (`load-plugin`) and enter the package path.

Plain `editor.command` replaces a command with the same name, so command iteration is easy. Hooks, advice, timers, and raw keymap mutations can accumulate unless they are cleaned up.

For reload-friendly packages, accept a plugin context and register through it:

```ts
import {
  createPluginContext,
  type PluginContext,
} from "@jemacs/core"

export function install(editor: Editor, ctx?: PluginContext): void {
  const c = ctx ?? createPluginContext(editor)
  c.command("my-package-hello", ({ editor }) => {
    editor.message("hello")
  }, "Say hello.")
  c.key("global", "C-c m h", "my-package-hello")
}
```

Built-in plugins use `ctx.command`, `ctx.key`, `ctx.hook`, `ctx.advice`, `ctx.minorMode`, and `ctx.onDispose` so reload disposes the previous install before installing the new one. If you are only auto-loading from `jemacs-stephen-config`, a simple `install(editor)` is fine for rough experiments.

## Testing

For pure helpers, export them and test them directly. The core repository's
`packages-test/` directory contains additional integration tests. Point those
tests at this checkout with `JEMACS_PACKAGES` when it is not installed at the
default path.

Example:

```bash
cd /path/to/jemacs-core
JEMACS_PACKAGES=/path/to/jemacs-packages \
  bun test ./packages-test/projectile.ts ./packages-test/file-sidebar.ts
```

For package changes that touch kernel behavior, run the normal checks in `jemacs-opentui`:

```bash
bun run check
bun test
```

For UI behavior, restart `jemacs` and verify the command or mode interactively.

## Rough Checklist

1. Create `jemacs-packages/<name>/index.ts`.
2. Export `install(editor)`.
3. Register one package-prefixed command.
4. Bind it under a package-owned prefix, usually something under `C-c`.
5. Restart jemacs or reload the package file.
6. Move helpers into separate files once the package grows.
7. Add focused tests in `jemacs-opentui/packages-test/` when behavior becomes non-trivial.
