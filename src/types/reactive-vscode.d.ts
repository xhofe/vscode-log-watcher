import type { LogEntry, LogTreeNode } from '../stores/logState'

declare module 'reactive-vscode' {
  interface Commands {
    'vscode-log-watcher.selectLogFile': () => Promise<void>
    'vscode-log-watcher.setLogLevelFilter': () => Promise<void>
    'vscode-log-watcher.setKeywordFilter': () => Promise<void>
    'vscode-log-watcher.setHighlightKeyword': () => Promise<void>
    'vscode-log-watcher.pause': () => Promise<void>
    'vscode-log-watcher.resume': () => Promise<void>
    'vscode-log-watcher.clearEntries': () => Promise<void>
    'vscode-log-watcher.toggleAutoScroll': () => Promise<void>
    'vscode-log-watcher.formatJsonLine': (target: LogEntry | LogTreeNode) => Promise<void>
    'vscode-log-watcher.copyLogLine': (target: LogEntry | LogTreeNode) => Promise<void>
    'vscode-log-watcher.goToLogLine': (target: LogEntry | LogTreeNode) => Promise<void>
  }
}
