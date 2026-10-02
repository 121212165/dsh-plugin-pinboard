# dsh-plugin-pinboard

**EN** · Cross-session pinboard: `/pin` stores a note, and pinned notes ride into every session's system prompt inside a hard budget (`limit` × `maxChars`, section order 700 so tool sections start after 1000); `pin_add` lets the model pin on its own. · 6 `node --test` green · two real headless sessions proved a pin written in session A shows up in session B's prompt log · a bad config (`limit: -1`) fails at boot naming `pinboard` instead of dragging the harness down.

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

三步，实测于 `@deepseek-ai/dsh@0.1.7-alpha.1`（需 `pnpm` 在 PATH 上）：

```sh
# ① 装进 profile：dsh plugin 把参数原样转发给 pnpm，git 包会自动跑 prepare 构建 lib/
dsh plugin --profile web add github:121212165/dsh-plugin-pinboard
```

② 把本仓库根目录 `cordis.patch.yml` 的内容**并进** `$DSH_HOME/profiles/web/cordis.patch.yml`。
该文件默认是 `[]`，所以要么整份替换，要么把 insert 条目并进同一个数组；**不要直接追加**——
追加会形成两个 YAML 文档，启动即报
`failed to parse overlay ... end of the stream or a document separator is expected`（本机实测踩过）。

③ 重启 dsh。配置层与 client 半都要重启才生效（客户端按 boot 时算出的内容 rev 下发，硬刷新浏览器没用）。

自检挂载：`dsh --profile web --dump-config | grep dsh-plugin-pinboard`，应看到该条目。
## 验证状态

- 纯函数（增删、去重、ID 递增、容错解析、预算裁剪、截断、列表标注）6 个 `node --test` 全绿。
- 本机 live 验证：两个真实 headless 会话——A 会话由模型调用 `pin_add` 写入便签，B 会话的 `session.v4.jsonl.zstd` 里**系统提示确实包含该段落**（跨会话注入成立）。
- 非法配置探针：`limit: -1` 时启动失败并点名 `pinboard (dsh-plugin-pinboard): ValidationError`，不会拖垮 harness。
- 未验证：`/pin` 在 web UI 命令面板里的手动输入体验（headless 无输入通道，验证走的是命令 handler 直接调用）。

## 测试

```bash
npm run check   # typecheck + node --test + tsc build
```

13 个测试：6 个纯函数（便签模型/预算裁剪）+ 7 个装配层集成测试（真实 apply() 挂 mock ctx，真临时目录驱动 /pin /unpin /pins、pin_add 工具与提示注入段）。

> 装配层测试 harness 借鉴 dsh-auto-review（222★，PerryLink）的 mountHarness 方法论，node:test 版实现来自 [dsh-plugin-task-forge](https://github.com/121212165/dsh-plugin-task-forge)（本家族首个装配层覆盖的插件）。
