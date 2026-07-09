# Setup

The packages repository no longer requires a sibling core checkout. Install the
core globally, then install packages:

```sh
/path/to/jemacs-core/scripts/install.sh
./scripts/install.sh
```

The default layout is:

```text
~/.local/share/jemacs/       core installation
~/.jemacs/packages/          this repository
```

For development against an uninstalled checkout:

```sh
JEMACS_HOME=/path/to/jemacs-core bun install
bun run check
bun test
```

`bun install` runs `scripts/link-core.sh`, which creates
`node_modules/@jemacs/core` from `JEMACS_HOME` (or the global default). No
relative checkout path is encoded in `package.json` or `tsconfig.json`.

## Pinning

`.jemacs-core-pin` records the Jemacs revision used by CI. Update it explicitly
when packages require a newer core API:

```sh
git -C /path/to/jemacs-core rev-parse HEAD > .jemacs-core-pin
```

## Importing

Use the public barrel instead of reaching into the core checkout:

```ts
import type { Editor } from "@jemacs/core"
import { Keymap, addHook, defineMinorMode, spawnProcess } from "@jemacs/core"
```

Built-in plugins are not part of `@jemacs/core`. Accept them as a dependency
bag in `install(editor, deps)`, or dynamically import them from `JEMACS_HOME`
when integration with a built-in is unavoidable.
