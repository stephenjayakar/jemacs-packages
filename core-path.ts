import { homedir } from "node:os"
import { join } from "node:path"

/** Installed core location, overridable when developing against another checkout. */
export function jemacsHome(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return process.env.JEMACS_HOME ?? join(dataHome, "jemacs")
}
