type Editor = {
  command(name: string, fn: (ctx: { editor: Editor }) => void | Promise<void>, doc?: string): void
  message(text: string): void
}

/** Sample experimental package — replace with real plugins as you add them. */
export function install(editor: Editor): void {
  editor.command("demo-package-hello", ({ editor: ed }) => {
    ed.message("hello from jemacs-packages/demo-package")
  })
}
