import { expect, test } from "bun:test"

import { projectileOtherFileCandidates } from "./projectile"

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
