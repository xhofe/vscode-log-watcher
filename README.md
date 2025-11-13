# vscode-log-watcher

<a href="https://marketplace.visualstudio.com/items?itemName=xhofe.vscode-log-watcher" target="__blank"><img src="https://img.shields.io/visual-studio-marketplace/v/xhofe.vscode-log-watcher.svg?color=eee&amp;label=VS%20Code%20Marketplace&logo=visual-studio-code" alt="Visual Studio Marketplace Version" /></a>
<a href="https://kermanx.github.io/reactive-vscode/" target="__blank"><img src="https://img.shields.io/badge/made_with-reactive--vscode-%23007ACC?style=flat&labelColor=%23229863"  alt="Made with reactive-vscode" /></a>

## Configurations

<!-- configs -->

| Key                                   | Description                                                                                                                             | Type     | Default |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| `vscode-log-watcher.defaultFile`      | 扩展激活时自动监听的默认日志文件绝对路径。留空则不自动打开。                                                                                                          | `string` | `""`    |
| `vscode-log-watcher.contentTransform` | 自定义 JavaScript 代码，用于将每一行日志转换成面板展示内容。可写函数表达式（例如 `line =&gt; line.trim()`）或函数体（例如 `return line.trim()`）。当返回 `undefined` 或抛出异常时，将回退为原始日志行。 | `string` | `""`    |

<!-- configs -->

## Commands

<!-- commands -->

| Command                                  | Title                    |
| ---------------------------------------- | ------------------------ |
| `vscode-log-watcher.selectLogFile`       | 选择/切换文件     |
| `vscode-log-watcher.setLogLevelFilter`   | 日志等级过滤      |
| `vscode-log-watcher.setKeywordFilter`    | 关键字过滤       |
| `vscode-log-watcher.setHighlightKeyword` | 关键字高亮       |
| `vscode-log-watcher.pause`               | 暂停监听        |
| `vscode-log-watcher.resume`              | 恢复监听        |
| `vscode-log-watcher.clearEntries`        | 清空日志        |
| `vscode-log-watcher.toggleAutoScroll`    | 自动滚动        |
| `vscode-log-watcher.formatJsonLine`      | JSON 格式化选中行 |

<!-- commands -->

## Presets

- fls
```js
(text: string) => {
    const obj = JSON.parse(text)
    const time = new Date(obj._datetime_).toLocaleString()
    return time + ' ' + obj._level_.toUpperCase() + ' ' + obj._msg_
}
```

## License

[MIT](./LICENSE.md) License © 2025 [Andy Hsu](https://github.com/xhofe)
