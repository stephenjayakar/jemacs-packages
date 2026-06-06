# Setup

This repo depends on `@jemacs/core` from a **sibling checkout** of the `jemacs` repo:

```
~/src/
  jemacs/             # github.com/stephenjayakar/jemacs
  jemacs-packages/    # this repo
```

The `file:../jemacs/packages/jemacs-core` dep in `package.json` resolves through that layout. If your checkout is named differently (e.g. `jemacs-opentui`), either rename it or symlink: `ln -s jemacs-opentui jemacs`.

```sh
bun install          # links @jemacs/core
bun run check        # tsc
bun test
```

## Pinning

`.jemacs-core-pin` holds the `jemacs` SHA this repo is tested against. CI checks out exactly that rev as the sibling. Bump it when you need a newer core:

```sh
git -C ../jemacs rev-parse HEAD > .jemacs-core-pin
```

## Why not a submodule?

Multiple consumer repos (this one + a work-packages repo) depend on one core — that's a package dependency, not vendored source. Submodules would put packages *inside* jemacs and add git friction (`--recursive`, detached HEAD) for nothing a `file:` dep doesn't already give you. When `@jemacs/core` publishes to npm, this becomes `"@jemacs/core": "^0.x"` and the sibling-checkout requirement goes away.

## Importing

```ts
import type { Editor } from "@jemacs/core"
import { Keymap, addHook } from "@jemacs/core"
import { defineMinorMode } from "@jemacs/core/modes/minor-mode"
import { spawnProcess } from "@jemacs/core/platform/runtime"
```

Plugin-to-plugin deps (e.g. `plugins/compile`'s `compilationStart`) aren't in `@jemacs/core` — for now reach them via `@jemacs/core/../../plugins/compile` or take them as a deps-bag in `install(editor, deps)`. A `@jemacs/builtin-plugins` package is the eventual answer.
