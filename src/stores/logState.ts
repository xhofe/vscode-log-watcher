import type { TreeViewNode } from 'reactive-vscode'
import { createSingletonComposable, tryOnScopeDispose } from 'reactive-vscode'
import { computed, ref } from '@reactive-vscode/reactivity'
import { ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri, window, workspace } from 'vscode'
import { LogWatcher, type LogUpdate } from '../services/logWatcher'

const MAX_ENTRIES = 2000

export type LogLevel = 'error' | 'warning' | 'info' | 'other'
export type LogLevelFilter = 'all' | Exclude<LogLevel, 'other'>

export interface LogEntry {
  id: string
  text: string
  level: LogLevel
  timestamp: number
}

export interface LogTreeNode extends TreeViewNode {
  kind: 'control' | 'log' | 'empty'
  entry?: LogEntry
}

const levelIcons: Record<LogLevel, ThemeIcon> = {
  error: new ThemeIcon('error'),
  warning: new ThemeIcon('warning'),
  info: new ThemeIcon('info'),
  other: new ThemeIcon('circle-outline'),
}

const levelLabels: Record<LogLevelFilter, string> = {
  all: '全部',
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
}

function detectLevel(text: string): LogLevel {
  const lower = text.toLowerCase()
  if (/\berror\b/.test(lower))
    return 'error'
  if (/\bwarn(?:ing)?\b/.test(lower))
    return 'warning'
  if (/\binfo\b/.test(lower))
    return 'info'
  return 'other'
}

function createEntryId(counter: number) {
  return `${Date.now()}-${counter}`
}

function parseKeywords(raw: string) {
  return raw
    .split(/[\s,]+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean)
}

function computeHighlights(text: string, keywords: string[]): [number, number][] {
  if (!keywords.length)
    return []
  const lower = text.toLowerCase()
  const ranges: [number, number][] = []

  for (const keyword of keywords) {
    let fromIndex = 0
    while (fromIndex >= 0) {
      const index = lower.indexOf(keyword, fromIndex)
      if (index === -1)
        break
      ranges.push([index, index + keyword.length])
      fromIndex = index + keyword.length
    }
  }

  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []

  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    }
    else {
      merged.push([...range] as [number, number])
    }
  }

  return merged
}

export const useLogState = createSingletonComposable(() => {
  const selectedFile = ref<Uri>()
  const entries = ref<LogEntry[]>([])
  const levelFilter = ref<LogLevelFilter>('all')
  const keywordFilter = ref('')
  const highlightKeyword = ref('')
  const watcherRef = ref<LogWatcher>()
  let watcherSubscription: { dispose(): void } | undefined
  let entryCounter = 0

  function resetEntries(lines: string[]) {
    entryCounter = 0
    entries.value = lines.map((line) => {
      const entry: LogEntry = {
        id: createEntryId(entryCounter++),
        text: line,
        level: detectLevel(line),
        timestamp: Date.now(),
      }
      return entry
    }).slice(-MAX_ENTRIES)
  }

  function appendEntries(lines: string[]) {
    if (!lines.length)
      return
    const newEntries = lines.map((line) => {
      const entry: LogEntry = {
        id: createEntryId(entryCounter++),
        text: line,
        level: detectLevel(line),
        timestamp: Date.now(),
      }
      return entry
    })
    entries.value = [...entries.value, ...newEntries].slice(-MAX_ENTRIES)
  }

  function disposeWatcher() {
    watcherSubscription?.dispose()
    watcherSubscription = undefined
    watcherRef.value?.dispose()
    watcherRef.value = undefined
  }

  async function watchFile(uri: Uri) {
    disposeWatcher()
    entryCounter = 0
    entries.value = []
    const watcher = new LogWatcher()
    watcherRef.value = watcher
    watcherSubscription = watcher.onDidUpdate((update: LogUpdate) => {
      if (update.type === 'reset') {
        resetEntries(update.lines)
      }
      else {
        appendEntries(update.lines)
      }
    })
    try {
      await watcher.watchFile(uri)
      selectedFile.value = uri
    }
    catch (error) {
      disposeWatcher()
      void window.showErrorMessage(`无法读取日志文件: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  async function clearFile() {
    disposeWatcher()
    selectedFile.value = undefined
    entries.value = []
    entryCounter = 0
  }

  const keywordTokens = computed(() => parseKeywords(keywordFilter.value))
  const highlightTokens = computed(() => parseKeywords(highlightKeyword.value))

  const filteredEntries = computed(() => {
    const tokens = keywordTokens.value
    const level = levelFilter.value
    if (!tokens.length && level === 'all')
      return entries.value

    return entries.value.filter((entry) => {
      if (level !== 'all' && entry.level !== level)
        return false
      if (!tokens.length)
        return true
      const lower = entry.text.toLowerCase()
      return tokens.every(token => lower.includes(token))
    })
  })

  const controlMessage = computed(() => {
    const parts: string[] = []
    const fileLabel = selectedFile.value
      ? workspace.asRelativePath(selectedFile.value, false)
      : '未选择日志文件'

    parts.push(`当前文件：${fileLabel}`)
    parts.push(`[日志等级: ${levelLabels[levelFilter.value]}]`)

    const keywordText = keywordFilter.value ? keywordFilter.value : '（无）'
    parts.push(`[关键字过滤: ${keywordText}]`)

    const highlightText = highlightKeyword.value ? highlightKeyword.value : '（无）'
    parts.push(`[关键字高亮: ${highlightText}]`)

    return parts.join('  |  ')
  })

  const treeData = computed<LogTreeNode[]>(() => {
    const data: LogTreeNode[] = []

    if (!filteredEntries.value.length) {
      const emptyItem = new TreeItem(selectedFile.value ? '暂无匹配的日志行' : '请选择日志文件', TreeItemCollapsibleState.None)
      emptyItem.iconPath = new ThemeIcon('info')
      data.push({
        kind: 'empty',
        treeItem: emptyItem,
      })
      return data
    }

    const highlightKeywords = highlightTokens.value

    for (const entry of filteredEntries.value) {
      const label = {
        label: entry.text,
        highlights: computeHighlights(entry.text, highlightKeywords),
      }
      const item = new TreeItem(label, TreeItemCollapsibleState.None)
      item.contextValue = 'logLine'
      item.iconPath = levelIcons[entry.level]
      item.tooltip = entry.text
      data.push({
        kind: 'log',
        entry,
        treeItem: item,
      })
    }

    return data
  })

  tryOnScopeDispose(() => {
    disposeWatcher()
  })

  return {
    selectedFile,
    entries,
    levelFilter,
    keywordFilter,
    highlightKeyword,
    filteredEntries,
    treeData,
    watchFile,
    clearFile,
      controlMessage,
    setLevelFilter(value: LogLevelFilter) {
      levelFilter.value = value
    },
    setKeywordFilter(value: string) {
      keywordFilter.value = value
    },
    setHighlightKeyword(value: string) {
      highlightKeyword.value = value
    },
  }
})

