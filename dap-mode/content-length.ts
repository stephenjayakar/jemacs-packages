/** Incremental UTF-8 Content-Length framing used by Debug Adapter Protocol. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index
  }
  return -1
}

export function serializeContentLength(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${new TextEncoder().encode(body).byteLength}\r\n\r\n${body}`
}

export class ContentLengthMessageParser<T = unknown> {
  private bodyLength: number | null = null
  private bodyReceived = 0
  private bodyChunks: Uint8Array[] = []
  private leftovers: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

  feed(chunk: string | Uint8Array): T[] {
    const incoming = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
    let bytes: Uint8Array<ArrayBufferLike> = this.leftovers.length ? concatBytes(this.leftovers, incoming) : incoming
    this.leftovers = new Uint8Array(0)
    const messages: T[] = []
    while (bytes.length > 0) {
      if (this.bodyLength == null) {
        const separator = headerEnd(bytes)
        if (separator === -1) { this.leftovers = bytes; break }
        const headers = new TextDecoder().decode(bytes.subarray(0, separator))
        const match = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i)
        if (!match) throw new Error("Unable to find Content-Length header")
        this.bodyLength = Number(match[1])
        this.bodyReceived = 0
        this.bodyChunks = []
        bytes = bytes.subarray(separator + 4)
        continue
      }
      const take = bytes.subarray(0, this.bodyLength - this.bodyReceived)
      this.bodyChunks.push(take)
      this.bodyReceived += take.length
      bytes = bytes.subarray(take.length)
      if (this.bodyReceived === this.bodyLength) {
        const body = new TextDecoder().decode(concatBytes(...this.bodyChunks))
        this.bodyLength = null
        this.bodyReceived = 0
        this.bodyChunks = []
        try { messages.push(JSON.parse(body) as T) }
        catch (error) { throw new Error(`Failed to parse framed JSON: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    return messages
  }
}
