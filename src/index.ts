import { effect } from '@reactive-vscode/reactivity'
import { defineExtension, tryOnScopeDispose, useCommands, useTreeView, useVscodeContext } from 'reactive-vscode'
import type { QuickPickItem } from 'vscode'
import { Uri, languages, window, workspace } from 'vscode'
import { useLogState, type LogEntry, type LogLevelFilter, type LogTreeNode } from './stores/logState'
import { JsonPreviewProvider, JSON_PREVIEW_SCHEME } from './providers/jsonPreview'
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
      .map(char => {
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

    if (char === startChar)
      depth++
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

  useVscodeContext('vscode-log-watcher.paused', state.isPaused)

  tryOnScopeDispose(() => {
    messageEffect.effect.stop()
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
      const options: Array<{ label: string; description: string; value: LogLevelFilter }> = [
        { label: '全部', description: '不过滤日志等级', value: 'all' },
        { label: 'Error', description: '仅显示 error', value: 'error' },
        { label: 'Warning', description: '仅显示 warning', value: 'warning' },
        { label: 'Info', description: '仅显示 info', value: 'info' },
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
  })

  return {
    treeView,
  }
})

export { activate, deactivate }
