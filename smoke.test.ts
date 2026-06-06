import { expect, test } from "bun:test"

test("@jemacs/core barrel resolves", async () => {
  const core = await import("@jemacs/core")
  expect(typeof core.Editor).toBe("function")
  expect(typeof core.Keymap).toBe("function")
  expect(typeof core.addHook).toBe("function")
})

test("each package's install is importable", async () => {
  for (const pkg of ["./projectile/projectile", "./file-sidebar/file-sidebar", "./demo-package/index"]) {
    const mod = await import(pkg)
    expect(typeof mod.install).toBe("function")
  }
})
