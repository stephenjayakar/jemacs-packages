import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setCustom } from "@jemacs/core"

import {
  PROJECTILE_COMMANDER_COMMANDS,
  projectileAddKnownProject,
  projectileCleanupKnownProjects,
  projectileKnownProjects,
  projectileOtherFileCandidates,
  resetProjectileStateForTests,
} from "./projectile"

let dir: string
let knownProjectsFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-projectile-"))
  knownProjectsFile = join(dir, "projectile-bookmarks.json")
  resetProjectileStateForTests()
  setCustom("projectile-known-projects-file", knownProjectsFile)
})

afterEach(async () => {
  resetProjectileStateForTests()
  await rm(dir, { recursive: true, force: true })
})

test("projectileOtherFileCandidates switches between C++ source and headers", () => {
  const files = [
    "src/widget.cpp",
    "src/widget.hpp",
    "src/widget_test.cpp",
  ]

  expect(projectileOtherFileCandidates("src/widget.cpp", files)).toEqual(["src/widget.hpp"])
  expect(projectileOtherFileCandidates("src/widget.hpp", files)).toEqual(["src/widget.cpp"])
})

test("projectileOtherFileCandidates switches between TypeScript implementation and test files", () => {
  const files = [
    "src/projectile.ts",
    "src/projectile.test.ts",
    "src/projectile.spec.ts",
  ]

  expect(projectileOtherFileCandidates("src/projectile.ts", files)).toEqual([
    "src/projectile.test.ts",
    "src/projectile.spec.ts",
  ])
  expect(projectileOtherFileCandidates("src/projectile.test.ts", files)).toEqual(["src/projectile.ts"])
})

test("projectileOtherFileCandidates includes same-basename matches in other directories", () => {
  const files = [
    "src/parser.cpp",
    "include/parser.hpp",
  ]

  expect(projectileOtherFileCandidates("src/parser.cpp", files)).toEqual(["include/parser.hpp"])
})

test("PROJECTILE_COMMANDER_COMMANDS maps single keys to real projectile commands", () => {
  expect(PROJECTILE_COMMANDER_COMMANDS.f.command).toBe("projectile-find-file")
  expect(PROJECTILE_COMMANDER_COMMANDS.b.command).toBe("projectile-switch-to-buffer")
  expect(PROJECTILE_COMMANDER_COMMANDS.d.command).toBe("projectile-find-dir")
  expect(PROJECTILE_COMMANDER_COMMANDS.s.command).toBe("projectile-grep")
  expect(PROJECTILE_COMMANDER_COMMANDS.r.command).toBe("projectile-replace")
  expect(PROJECTILE_COMMANDER_COMMANDS.T.command).toBe("projectile-test-project")
  expect(PROJECTILE_COMMANDER_COMMANDS.c.command).toBe("projectile-compile-project")
})

test("projectileCleanupKnownProjects removes known projects whose directories no longer exist", async () => {
  const keep = join(dir, "keep")
  const missing = join(dir, "missing")
  await mkdir(keep)
  await projectileAddKnownProject(missing)
  await projectileAddKnownProject(keep)

  const removed = await projectileCleanupKnownProjects()

  expect(removed).toEqual([resolve(missing)])
  expect(await projectileKnownProjects()).toEqual([resolve(keep)])
  expect(JSON.parse(await readFile(knownProjectsFile, "utf8"))).toEqual([resolve(keep)])
})
