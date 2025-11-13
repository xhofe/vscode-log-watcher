import type { TreeViewNode } from 'reactive-vscode'
import type { Uri } from 'vscode'
import type { LogUpdate } from '../services/logWatcher'
import type { CompiledContentTransform } from '../utils/contentTransform'
import { computed, ref } from '@reactive-vscode/reactivity'
import { createSingletonComposable, tryOnScopeDispose } from 'reactive-vscode'
import { ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, window, workspace } from 'vscode'
import { LogWatcher } from '../services/logWatcher'
import { applyContentTransform, compileContentTransform } from '../utils/contentTransform'

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
  error: new ThemeIcon('error', new ThemeColor('charts.red')),
  warning: new ThemeIcon('warning', new ThemeColor('charts.yellow')),
  info: new ThemeIcon('info', new ThemeColor('charts.blue')),
  other: new ThemeIcon('circle-outline'),
}

const levelLabels: Record<LogLevelFilter, string> = {
  all: '全部',
  info: 'Info 及以上',
  warning: 'Warning 及以上',
  error: '仅 Error',
}

const levelPriority: Record<LogLevel, number> = {
  other: 0,
  info: 1,
  warning: 2,
  error: 3,
}

const levelThreshold: Record<LogLevelFilter, number> = {
  all: Number.NEGATIVE_INFINITY,
  info: levelPriority.info,
  warning: levelPriority.warning,
  error: levelPriority.error,
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
  const isPaused = ref(false)
  const autoScroll = ref(true) // 自动滚动开关，默认开启
  const pendingLines = ref<string[]>([])
  const contentTransform = ref<CompiledContentTransform>(compileContentTransform(''))
  let lastTransformErrorKey: string | undefined
  const watcherRef = ref<LogWatcher>()
  let watcherSubscription: { dispose: () => void } | undefined
  let entryCounter = 0

  const selectedFileLabel = computed(() => {
    if (!selectedFile.value)
      return '未选择日志文件'
    return workspace.asRelativePath(selectedFile.value, false)
  })

  function updateContentTransform(source: string) {
    const compiled = compileContentTransform(source)
    contentTransform.value = compiled
    if (!compiled.error) {
      lastTransformErrorKey = undefined
      return
    }

    const key = `${compiled.source}::${compiled.error}`
    if (lastTransformErrorKey !== key) {
      lastTransformErrorKey = key
      void window.showErrorMessage(`内容转换函数无效: ${compiled.error}`)
    }
  }

  function loadContentTransform() {
    const value = workspace.getConfiguration('vscode-log-watcher').get<string>('contentTransform', '') ?? ''
    updateContentTransform(value)
  }

  loadContentTransform()

  const configDisposable = workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('vscode-log-watcher.contentTransform'))
      loadContentTransform()
  })

  function resetEntries(lines: string[]) {
    entryCounter = 0
    pendingLines.value = []
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
    pendingLines.value = []
    const watcher = new LogWatcher()
    watcherRef.value = watcher
    watcherSubscription = watcher.onDidUpdate((update: LogUpdate) => {
      if (update.type === 'reset') {
        resetEntries(update.lines)
      }
      else {
        if (isPaused.value) {
          pendingLines.value = [...pendingLines.value, ...update.lines].slice(-MAX_ENTRIES)
          return
        }
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
    pendingLines.value = []
  }

  function clearEntriesState() {
    entries.value = []
    entryCounter = 0
  }

  const keywordTokens = computed(() => parseKeywords(keywordFilter.value))
  const highlightTokens = computed(() => parseKeywords(highlightKeyword.value))

  const filteredEntries = computed(() => {
    const tokens = keywordTokens.value
    const level = levelFilter.value
    const threshold = levelThreshold[level]

    if (!tokens.length && threshold === Number.NEGATIVE_INFINITY)
      return entries.value

    return entries.value.filter((entry) => {
      const priority = levelPriority[entry.level] ?? Number.NEGATIVE_INFINITY
      if (priority < threshold)
        return false
      if (!tokens.length)
        return true
      const lower = entry.text.toLowerCase()
      return tokens.every(token => lower.includes(token))
    })
  })

  const lastFilteredEntryId = computed(() => {
    const filtered = filteredEntries.value
    return filtered.length > 0 ? filtered[filtered.length - 1].id : undefined
  })

  const controlMessage = computed(() => {
    const keywordText = keywordFilter.value ? keywordFilter.value : '（无）'
    const highlightText = highlightKeyword.value ? highlightKeyword.value : '（无）'
    const transformLabel = contentTransform.value.source
      ? contentTransform.value.error
        ? `${contentTransform.value.source.slice(0, 40)}…（无效）`
        : contentTransform.value.source.length > 60
          ? `${contentTransform.value.source.slice(0, 60)}…`
          : contentTransform.value.source
      : '（无）'
    const pendingText = pendingLines.value.length
      ? `（待处理 ${pendingLines.value.length} 行）`
      : ''
    const status = isPaused.value ? `已暂停${pendingText}` : '监听中'
    const autoScrollText = autoScroll.value ? '开启' : '关闭'

    return [
      `状态: ${status}`,
      `当前文件: ${selectedFileLabel.value}`,
      `日志等级: ${levelLabels[levelFilter.value]}`,
      `关键字过滤: ${keywordText}`,
      `关键字高亮: ${highlightText}`,
      `内容函数: ${transformLabel}`,
      `自动滚动: ${autoScrollText}`,
    ].join('  |  ')
  })

  const treeData = computed<LogTreeNode[]>(() => {
    const data: LogTreeNode[] = []

    // if (selectedFile.value) {
    //   const statusItem = new TreeItem(isPaused.value ? '恢复监听' : '暂停监听', TreeItemCollapsibleState.None)
    //   statusItem.command = {
    //     title: isPaused.value ? '恢复监听' : '暂停监听',
    //     command: isPaused.value ? 'vscode-log-watcher.resume' : 'vscode-log-watcher.pause',
    //   }
    //   statusItem.iconPath = new ThemeIcon(isPaused.value ? 'debug-start' : 'debug-pause')
    //   if (pendingLines.value.length)
    //     statusItem.description = `待处理 ${pendingLines.value.length} 行`
    //   data.push({
    //     kind: 'control',
    //     treeItem: statusItem,
    //   })

    //   const clearItem = new TreeItem('清空日志列表', TreeItemCollapsibleState.None)
    //   clearItem.command = {
    //     title: '清空日志列表',
    //     command: 'vscode-log-watcher.clearEntries',
    //   }
    //   clearItem.iconPath = new ThemeIcon('trash')
    //   data.push({
    //     kind: 'control',
    //     treeItem: clearItem,
    //   })
    // }

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
      const displayText = applyContentTransform(entry.text, contentTransform.value)
      const label = {
        label: displayText,
        highlights: computeHighlights(displayText, highlightKeywords),
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
    configDisposable.dispose()
  })

  return {
    selectedFile,
    entries,
    levelFilter,
    keywordFilter,
    highlightKeyword,
    isPaused,
    autoScroll,
    filteredEntries,
    lastFilteredEntryId,
    treeData,
    controlMessage,
    selectedFileLabel,
    watchFile,
    clearFile,
    clearEntries: clearEntriesState,
    pause() {
      if (!isPaused.value)
        isPaused.value = true
    },
    resume() {
      if (!isPaused.value)
        return
      isPaused.value = false
      if (pendingLines.value.length) {
        const buffered = pendingLines.value
        pendingLines.value = []
        appendEntries(buffered)
      }
    },
    toggleAutoScroll() {
      autoScroll.value = !autoScroll.value
    },
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
