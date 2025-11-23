import type { FSWatcher } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { Disposable, Uri } from 'vscode'
import { Buffer } from 'node:buffer'
import { watch } from 'node:fs'
import { open } from 'node:fs/promises'
import { EventEmitter } from 'vscode'

export type LogUpdate =
  | {
    type: 'reset'
    lines: Array<{ text: string, lineNumber: number }>
  }
  | {
    type: 'append'
    lines: Array<{ text: string, lineNumber: number }>
  }

const TAIL_READ_SIZE = 64 * 1024
const TAIL_READ_COUNT = 50

async function countTotalLines(handle: FileHandle): Promise<number> {
  const stat = await handle.stat()
  if (stat.size === 0)
    return 0

  const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024)) // 最多读取 1MB
  let totalLines = 0
  let position = 0

  while (position < stat.size) {
    const length = Math.min(buffer.length, stat.size - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead === 0)
      break

    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const normalized = text.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    totalLines += lines.length - 1 // -1 因为 split 会多一个元素
    position += bytesRead
  }

  // 如果文件不以换行符结尾，需要加1
  if (position > 0 && stat.size > 0) {
    const lastCharBuffer = Buffer.alloc(1)
    await handle.read(lastCharBuffer, 0, 1, stat.size - 1)
    const lastChar = lastCharBuffer[0]
    if (lastChar !== 0x0A && lastChar !== 0x0D) // 不是 \n 或 \r
      totalLines += 1
  }

  return totalLines
}

async function readTailLines(handle: FileHandle, count: number): Promise<Array<{ text: string, lineNumber: number }>> {
  const stat = await handle.stat()
  if (stat.size === 0)
    return []

  // 先计算总行数
  const totalLines = await countTotalLines(handle)
  if (totalLines === 0)
    return []

  // 读取最后部分
  const length = Math.min(stat.size, TAIL_READ_SIZE)
  const position = stat.size - length
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  const text = buffer.subarray(0, bytesRead).toString('utf8')
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  if (position > 0 && lines.length > 0)
    lines.shift()

  const tailLines = lines.slice(-count)

  // 计算行号：从总行数减去尾部行数，然后加1（因为行号从1开始）
  const startLineNumber = Math.max(1, totalLines - tailLines.length + 1)

  return tailLines.map((line, index) => ({
    text: line,
    lineNumber: startLineNumber + index,
  }))
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
  private currentLineNumber = 0 // 当前行号（用于追加时）
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
    this.currentLineNumber = 0
  }

  private async openHandle(uri: Uri) {
    this.handle = await open(uri.fsPath, 'r')
  }

  private async emitInitialLines() {
    if (!this.handle)
      return
    const initialLines = await readTailLines(this.handle, TAIL_READ_COUNT)
    const stat = await this.handle.stat()
    this.offset = stat.size
    this.remainder = ''
    // 设置当前行号为最后一行
    if (initialLines.length > 0) {
      this.currentLineNumber = initialLines[initialLines.length - 1].lineNumber
    }
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
      this.currentLineNumber = 0
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
      // 为每行分配行号
      const linesWithNumbers = lines.map((line) => {
        this.currentLineNumber += 1
        return {
          text: line,
          lineNumber: this.currentLineNumber,
        }
      })
      this.emitter.fire({
        type: 'append',
        lines: linesWithNumbers,
      })
    }
  }
}
