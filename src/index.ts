import type { QuickPickItem } from 'vscode'
import type { LogEntry, LogLevelFilter, LogTreeNode } from './stores/logState'
import { effect } from '@reactive-vscode/reactivity'
import { defineExtension, tryOnScopeDispose, useCommands, useTreeView, useVscodeContext } from 'reactive-vscode'
import { env, languages, Range, Selection, TextEditorRevealType, Uri, window, workspace } from 'vscode'
import { JSON_PREVIEW_SCHEME, JsonPreviewProvider } from './providers/jsonPreview'
import { useLogState } from './stores/logState'
import { logger } from './utils'

const VIEW_ID = 'vscode-log-watcher.logPanel'
const LOG_FILE_GLOB = '**/*.{log,txt,json,jsonl,ndjson,fls}'
const LOG_FILE_EXCLUDES = '**/{.git,node_modules,vendor,dist,out,build,tmp,temp}/**'
const JSON_PREVIEW_URI = Uri.from({ scheme: JSON_PREVIEW_SCHEME, path: '/formatted.json' })

interface LogQuickPickItem extends QuickPickItem {
  uri: Uri
}

function isLogTreeNode(target: LogEntry | LogTreeNode): target is LogTreeNode {
  return 'kind' in target
}

function extractJsonSnippet(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed)
    return undefined

  const firstBrace = Math.min(
    ...['{', '[']
      .map((char) => {
        const index = trimmed.indexOf(char)
        return index === -1 ? Number.POSITIVE_INFINITY : index
      }),
  )

  if (!Number.isFinite(firstBrace))
    return undefined

  const startChar = trimmed[firstBrace] as '{' | '['
  const closeChar = startChar === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = firstBrace; i < trimmed.length; i++) {
    const char = trimmed[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"')
        inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === startChar) {
      depth++
    }
    else if (char === closeChar) {
      depth--
      if (depth === 0)
        return trimmed.slice(firstBrace, i + 1)
    }
  }

  return undefined
}

async function pickLogFile(current?: Uri) {
  const files = await workspace.findFiles(LOG_FILE_GLOB, LOG_FILE_EXCLUDES, 200)
  if (!files.length) {
    void window.showWarningMessage('未在工作区内找到 .log/.txt/.json/.jsonl 文件')
    return undefined
  }

  const items: LogQuickPickItem[] = files
    .sort((a, b) => workspace.asRelativePath(a).localeCompare(workspace.asRelativePath(b)))
    .map((uri) => {
      const label = workspace.asRelativePath(uri, false)
      return {
        label,
        description: uri.fsPath,
        uri,
        picked: current?.fsPath === uri.fsPath,
      }
    })

  const pick = await window.showQuickPick(items, {
    title: '选择日志文件',
    placeHolder: '搜索并选择要监控的日志文件',
    matchOnDescription: true,
  })

  return pick?.uri
}

const { activate, deactivate } = defineExtension(() => {
  const state = useLogState()
  const treeView = useTreeView<LogTreeNode>(VIEW_ID, state.treeData, {
    showCollapseAll: false,
  })

  const jsonPreviewProvider = new JsonPreviewProvider()
  const jsonPreviewDisposable = workspace.registerTextDocumentContentProvider(JSON_PREVIEW_SCHEME, jsonPreviewProvider)

  const messageEffect = effect(() => {
    treeView.message = state.controlMessage.value
  })

  // 跟踪最后一个显示的日志条目 ID，用于判断是否需要自动滚动
  let lastRevealedEntryId: string | undefined

  // 当文件变化或日志清空时，重置状态
  const resetEffect = effect(() => {
    const selectedFile = state.selectedFile.value
    const lastEntryId = state.lastFilteredEntryId.value

    // 如果文件被清空或切换，重置状态
    if (!selectedFile || !lastEntryId) {
      lastRevealedEntryId = undefined
    }
  })

  // 监听日志变化，自动滚动到底部
  const autoScrollEffect = effect(() => {
    const lastEntryId = state.lastFilteredEntryId.value
    if (!lastEntryId || !state.autoScroll.value)
      return

    // 如果最后一个条目发生了变化（有新日志），则滚动到该条目
    if (lastEntryId !== lastRevealedEntryId) {
      const treeData = state.treeData.value
      const lastNode = treeData.find(node => node.kind === 'log' && node.entry?.id === lastEntryId)
      if (lastNode) {
        // 使用 setTimeout 确保 DOM 已更新
        setTimeout(() => {
          void treeView.reveal(lastNode, { select: false, focus: false, expand: false })
          lastRevealedEntryId = lastEntryId
        }, 0)
      }
    }
  })

  useVscodeContext('vscode-log-watcher.paused', state.isPaused)
  useVscodeContext('vscode-log-watcher.autoScroll', state.autoScroll)

  tryOnScopeDispose(() => {
    messageEffect.effect.stop()
    resetEffect.effect.stop()
    autoScrollEffect.effect.stop()
  })

  tryOnScopeDispose(() => {
    jsonPreviewProvider.dispose()
    jsonPreviewDisposable.dispose()
  })

  useCommands({
    'vscode-log-watcher.selectLogFile': async () => {
      const uri = await pickLogFile(state.selectedFile.value)
      if (!uri)
        return
      await state.watchFile(uri)
      logger.info('已开始监听日志文件', uri.fsPath)
    },
    'vscode-log-watcher.setLogLevelFilter': async () => {
      const options: Array<{ label: string, description: string, value: LogLevelFilter }> = [
        { label: '全部', description: '显示全部日志等级', value: 'all' },
        { label: 'Info 及以上', description: '显示 info / warning / error', value: 'info' },
        { label: 'Warning 及以上', description: '显示 warning / error', value: 'warning' },
        { label: '仅 Error', description: '只显示 error', value: 'error' },
      ]
      const pick = await window.showQuickPick(options, {
        title: '选择日志等级过滤',
        placeHolder: '选择要显示的日志等级',
      })
      if (pick)
        state.setLevelFilter(pick.value)
    },
    'vscode-log-watcher.setKeywordFilter': async () => {
      const value = await window.showInputBox({
        title: '设置关键字过滤',
        placeHolder: '输入关键字，多个以空格或逗号分隔。留空表示不过滤',
        value: state.keywordFilter.value,
        prompt: '仅保留包含所有关键字的日志行',
      })
      if (value === undefined)
        return
      state.setKeywordFilter(value.trim())
    },
    'vscode-log-watcher.setHighlightKeyword': async () => {
      const value = await window.showInputBox({
        title: '设置关键字高亮',
        placeHolder: '输入关键字，多个以空格或逗号分隔。留空表示取消高亮',
        value: state.highlightKeyword.value,
        prompt: '匹配的关键字将在面板中高亮显示',
      })
      if (value === undefined)
        return
      state.setHighlightKeyword(value.trim())
    },
    'vscode-log-watcher.pause': async () => {
      if (state.isPaused.value)
        return
      state.pause()
      logger.warn('日志监听已暂停')
    },
    'vscode-log-watcher.resume': async () => {
      if (!state.isPaused.value)
        return
      state.resume()
      logger.info('日志监听已恢复')
    },
    'vscode-log-watcher.clearEntries': async () => {
      state.clearEntries()
      logger.info('已清空日志列表')
    },
    'vscode-log-watcher.toggleAutoScroll': async () => {
      state.toggleAutoScroll()
      logger.info(`自动滚动已${state.autoScroll.value ? '开启' : '关闭'}`)
    },
    'vscode-log-watcher.formatJsonLine': async (target) => {
      const entry = isLogTreeNode(target) ? target.entry : target
      if (!entry) {
        void window.showWarningMessage('未找到可格式化的日志行')
        return
      }
      const snippet = extractJsonSnippet(entry.text)
      if (!snippet) {
        void window.showWarningMessage('选中的行中未发现 JSON 内容')
        return
      }
      try {
        const parsed = JSON.parse(snippet)
        const formatted = JSON.stringify(parsed, null, 2)
        jsonPreviewProvider.update(JSON_PREVIEW_URI, formatted)
        const doc = await workspace.openTextDocument(JSON_PREVIEW_URI)
        const jsonDoc = await languages.setTextDocumentLanguage(doc, 'json')
        await window.showTextDocument(jsonDoc, { preview: true })
      }
      catch (error) {
        void window.showErrorMessage(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    'vscode-log-watcher.copyLogLine': async (target) => {
      const entry = isLogTreeNode(target) ? target.entry : target
      if (!entry) {
        void window.showWarningMessage('未找到可复制的日志行')
        return
      }
      await env.clipboard.writeText(entry.text)
      logger.info('已复制日志行到剪贴板')
    },
    'vscode-log-watcher.goToLogLine': async (target) => {
      const entry = isLogTreeNode(target) ? target.entry : target
      if (!entry || !entry.lineNumber) {
        void window.showWarningMessage('未找到可跳转的日志行或行号不可用')
        return
      }
      const fileUri = state.selectedFile.value
      if (!fileUri) {
        void window.showWarningMessage('未选择日志文件')
        return
      }
      try {
        const doc = await workspace.openTextDocument(fileUri)
        const editor = await window.showTextDocument(doc)
        const lineNumber = entry.lineNumber - 1 // VS Code 行号从 0 开始
        const position = editor.selection.active.with(lineNumber, 0)
        editor.selection = new Selection(position, position)
        editor.revealRange(
          new Range(position, position),
          TextEditorRevealType.InCenter,
        )
        logger.info(`已跳转到第 ${entry.lineNumber} 行`)
      }
      catch (error) {
        void window.showErrorMessage(`无法打开文件: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })

  const defaultFile = workspace.getConfiguration('vscode-log-watcher').get<string>('defaultFile', '')
  if (defaultFile) {
    const uri = workspace.workspaceFolders
      ? Uri.joinPath(workspace.workspaceFolders[0].uri, defaultFile)
      : Uri.file(defaultFile)
    ;(async () => {
      try {
        await workspace.fs.stat(uri)
        if (!state.selectedFile.value)
          await state.watchFile(uri)
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('默认日志文件不可用', defaultFile, message)
      }
    })()
  }

  return {
    treeView,
  }
})

export { activate, deactivate }
