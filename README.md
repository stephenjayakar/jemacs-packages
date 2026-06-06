# jemacs-packages

Experimental jemacs plugins not yet upstreamed. Each package is a directory with `index.ts` exporting `install(editor)`.

Loaded automatically by `jemacs-stephen-config` from `~/.jemacs/packages/` (symlinked by `deploy.sh`).

## Getting Started With Packages

A package is just a directory under this repo:

```text
jemacs-packages/
  my-package/
    index.ts
```

`index.ts` must export an `install` function. The config loader imports packages alphabetically from `~/.jemacs/packages/<name>/index.ts`, so deploy once, restart `jemacs`, and the symlinked checkout is what gets loaded.

Start with the smallest useful package:

```ts
type Editor = import("../../jemacs-opentui/src/kernel/editor").Editor

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

Packages live outside `jemacs-opentui`, so imports usually do one of two things.

For types, static relative imports are fine:

```ts
type Editor = import("../../jemacs-opentui/src/kernel/editor").Editor
type BufferModel = import("../../jemacs-opentui/src/kernel/buffer").BufferModel
```

For runtime APIs, prefer resolving through `JEMACS_HOME` so the package follows the deployed editor checkout:

```ts
import { homedir } from "node:os"
import { join } from "node:path"

function jemacsHome(): string {
  return process.env.JEMACS_HOME ?? join(homedir(), "programming", "jemacs", "jemacs-opentui")
}

export async function install(editor: Editor): Promise<void> {
  const { defineMinorMode } = await import(join(jemacsHome(), "src/modes/minor-mode.ts"))
  // use defineMinorMode(...)
}
```

That fallback path is only for dev convenience. Normal launches set `JEMACS_HOME` through the `jemacs` wrapper.

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
import { Keymap } from "../../jemacs-opentui/src/kernel/keymap"

export async function install(editor: Editor): Promise<void> {
  const { defineMinorMode } = await import(join(jemacsHome(), "src/modes/minor-mode.ts"))

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
} from "../../jemacs-opentui/src/runtime/plugin-context"

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

For pure helpers, export them and test them directly. The sibling `jemacs-opentui/packages-test/` directory is reserved for tests that import this repo without making `bun test` pick them up by default.

Example:

```bash
cd ../jemacs-opentui
bun test packages-test/projectile.ts packages-test/file-sidebar.ts
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
