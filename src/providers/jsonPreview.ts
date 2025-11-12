import { EventEmitter, Uri, type Event, type TextDocumentContentProvider } from 'vscode'

const SCHEME = 'vscode-log-watcher-json'

export const JSON_PREVIEW_SCHEME = SCHEME

export class JsonPreviewProvider implements TextDocumentContentProvider {
  private readonly emitter = new EventEmitter<Uri>()
  private readonly cache = new Map<string, string>()

  get onDidChange(): Event<Uri> {
    return this.emitter.event
  }

  provideTextDocumentContent(uri: Uri): string {
    return this.cache.get(uri.toString()) ?? ''
  }

  update(uri: Uri, content: string) {
    this.cache.set(uri.toString(), content)
    this.emitter.fire(uri)
  }

  dispose() {
    this.emitter.dispose()
    this.cache.clear()
  }
}


