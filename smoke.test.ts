import { expect, test } from "bun:test"

test("@jemacs/core barrel resolves", async () => {
  const core = await import("@jemacs/core")
  expect(typeof core.Editor).toBe("function")
  expect(typeof core.Keymap).toBe("function")
  expect(typeof core.addHook).toBe("function")
})

import { readdirSync, existsSync } from "node:fs"

test("each package's install is importable", async () => {
  const pkgs = readdirSync(".", { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map(d => existsSync(`./${d.name}/index.ts`) ? `./${d.name}/index` : `./${d.name}/${d.name}`)
    .filter(p => existsSync(p + ".ts"))
  expect(pkgs.length).toBeGreaterThan(2)
  for (const pkg of pkgs) {
    const mod = await import(pkg)
    expect(typeof mod.install).toBe("function")
  }
})
