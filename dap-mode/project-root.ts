import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const rootMarkers = [".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "package.json", "go.mod", "Cargo.toml"]

/** Find the nearest LSP/projectile-style project root for a source file. */
export async function findProjectRoot(filePath: string): Promise<string> {
  let directory = dirname(resolve(filePath))
  const root = resolve("/")
  while (directory !== root) {
    for (const marker of rootMarkers) {
      try { await stat(resolve(directory, marker)); return directory }
      catch { /* Keep walking upward. */ }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return dirname(resolve(filePath))
}
