# dsh-plugin-pinboard

DeepSeek Harness (dsh) 插件：**跨会话置顶便签**。在任何会话里 `/pin` 一次，这条便签就会注入**之后每一个会话**的系统提示——不用重复交代，不用改 agent 配置文件。

适合回答："我怎么让 dsh 永远记住'回答用中文''别动 main 分支'这类长期约定？"

同系列：[fact-vault](https://github.com/121212165/dsh-plugin-fact-vault)（可检索的事实库，按需召回）· [prompt-vault](https://github.com/121212165/dsh-plugin-prompt-vault)（提示词弹药库，手动发送）· [session-insights](https://github.com/121212165/dsh-plugin-session-insights)。区别：fact-vault 是"模型自己去查"，pinboard 是"每次都直接告诉模型"。

## 用法

- **`/pin <一句话>`**：置顶一条便签（多余空白会压成单行；重复内容不会重复入库）。
- **`/unpin <id>`**：取消置顶（`#` 前缀可带可不带）。
- **`/pins`**：列出全部便签，`●` 表示真的会注入、`○` 表示因超出条数/字符上限被挤出去了。
- **`pin_add` 工具**：模型自己置顶——只在用户明确说"记住/以后都"时调用，返回值会告知是否进入了注入预算。

便签存为 `~/.dsh/pinboard/pins.jsonl`（按月不切分，单文件）。注入通过 `ctx.systemPrompt.section()`，段落文本是**每次组装时求值**的 provider，所以中途新增的便签下一回合就生效，不需要重启 dsh。

## 注入预算（关键设计）

便签会长期占系统提示，所以预算是硬的：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则完全不注册命令与段落 |
| `dataPath` | `~/.dsh/pinboard/pins.jsonl` | 便签文件 |
| `limit` | `12` | 最多注入几条 |
| `maxChars` | `1200` | 注入行的总字符上限（不含段落标题） |
| `order` | `700` | 系统提示段落顺序（官方工具段落从 1000 起，700 在策略段之后、工具段之前） |

选择规则：按 `at` 倒序（最新优先），逐条累加字符，装不下就停。**唯一一条超长时截断而不是丢弃**（末尾加 `…`），保证最新一条一定到达。

注入段落形态：

```text
## 置顶便签（pinboard）
用户置顶的持久指令，跨所有会话生效，优先于临时对话中的同类约定：
- 一律使用中文回答
- 代码注释也使用中文
```

## 安装

`npm i dsh-plugin-pinboard`，或克隆后 `npm install`（`prepare` 会构建出 `lib/`）再软链进 profile 的 node_modules；挂载片段见本仓库 `cordis.patch.yml`。需要 profile 里已有 `dsh-system-prompt`（base bundle 自带）。

## 验证状态

- 纯函数（增删、去重、ID 递增、容错解析、预算裁剪、截断、列表标注）6 个 `node --test` 全绿。
- 本机 live 验证：两个真实 headless 会话——A 会话由模型调用 `pin_add` 写入便签，B 会话的 `session.v4.jsonl.zstd` 里**系统提示确实包含该段落**（跨会话注入成立）。
- 非法配置探针：`limit: -1` 时启动失败并点名 `pinboard (dsh-plugin-pinboard): ValidationError`，不会拖垮 harness。
- 未验证：`/pin` 在 web UI 命令面板里的手动输入体验（headless 无输入通道，验证走的是命令 handler 直接调用）。
