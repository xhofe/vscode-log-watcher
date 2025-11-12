import { watch, type FSWatcher } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { EventEmitter, Uri, type Disposable } from 'vscode'

export type LogUpdate =
  | {
    type: 'reset'
    lines: string[]
  }
  | {
    type: 'append'
    lines: string[]
  }

const TAIL_READ_SIZE = 64 * 1024

async function readTailLines(handle: FileHandle, count: number): Promise<string[]> {
  const stat = await handle.stat()
  if (stat.size === 0)
    return []

  const length = Math.min(stat.size, TAIL_READ_SIZE)
  const position = stat.size - length
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  const text = buffer.subarray(0, bytesRead).toString('utf8')
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  if (position > 0 && lines.length > 0)
    lines.shift()

  return lines.slice(-count)
}

function extractLinesFromChunk(chunk: string, remainder: string) {
  const combined = remainder + chunk
  const normalized = combined.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  let nextRemainder = ''

  if (!normalized.endsWith('\n')) {
    nextRemainder = parts.pop() ?? ''
  }
  else if (parts.length && parts[parts.length - 1] === '') {
    parts.pop()
  }

  return {
    lines: parts,
    remainder: nextRemainder,
  }
}

export class LogWatcher implements Disposable {
  private readonly emitter = new EventEmitter<LogUpdate>()
  private watcher?: FSWatcher
  private handle?: FileHandle
  private offset = 0
  private remainder = ''
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  get onDidUpdate() {
    return this.emitter.event
  }

  async watchFile(uri: Uri) {
    await this.reset()
    await this.openHandle(uri)
    await this.emitInitialLines()
    this.createFsWatcher(uri)
  }

  dispose() {
    this.disposed = true
    void this.queue.finally(async () => {
      await this.reset()
      this.emitter.dispose()
    })
  }

  private async reset() {
    this.watcher?.close()
    this.watcher = undefined
    if (this.handle) {
      await this.handle.close().catch(() => {})
      this.handle = undefined
    }
    this.offset = 0
    this.remainder = ''
  }

  private async openHandle(uri: Uri) {
    this.handle = await open(uri.fsPath, 'r')
  }

  private async emitInitialLines() {
    if (!this.handle)
      return
    const initialLines = await readTailLines(this.handle, 50)
    const stat = await this.handle.stat()
    this.offset = stat.size
    this.remainder = ''
    this.emitter.fire({
      type: 'reset',
      lines: initialLines,
    })
  }

  private createFsWatcher(uri: Uri) {
    this.watcher = watch(uri.fsPath, { persistent: false }, (eventType) => {
      if (this.disposed || !this.handle)
        return

      if (eventType === 'rename') {
        this.enqueue(async () => {
          await this.reopen(uri)
          await this.emitInitialLines()
        })
        return
      }

      if (eventType === 'change') {
        this.enqueue(async () => {
          await this.readNewContent()
        })
      }
    })
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(() => task().catch((error) => {
      console.error('[log-watcher] failed to process file change', error)
    }))
  }

  private async reopen(uri: Uri) {
    if (this.handle) {
      await this.handle.close().catch(() => {})
      this.handle = undefined
    }
    try {
      this.handle = await open(uri.fsPath, 'r')
      this.offset = 0
      this.remainder = ''
    }
    catch (error) {
      console.error('[log-watcher] failed to reopen file', error)
    }
  }

  private async readNewContent() {
    if (!this.handle)
      return

    const stat = await this.handle.stat().catch((error) => {
      console.error('[log-watcher] stat failed', error)
      return null
    })

    if (!stat)
      return

    if (stat.size < this.offset) {
      this.offset = stat.size
      this.remainder = ''
      await this.emitInitialLines()
      return
    }

    const length = stat.size - this.offset
    if (length <= 0)
      return

    const buffer = Buffer.alloc(length)
    const { bytesRead } = await this.handle.read(buffer, 0, length, this.offset)
    if (bytesRead <= 0)
      return

    this.offset += bytesRead
    const chunk = buffer.subarray(0, bytesRead).toString('utf8')
    const { lines, remainder } = extractLinesFromChunk(chunk, this.remainder)
    this.remainder = remainder

    if (lines.length) {
      this.emitter.fire({
        type: 'append',
        lines,
      })
    }
  }
}

