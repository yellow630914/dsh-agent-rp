# [Bug] 世界书纯文本 key 被强制送进 QuickJS，原生快速路径失效

### 问题发生在哪里？

世界书或 EJS

### 实际发生了什么？

会话挂上一本条目较多、且条目普遍开启 `use_regex` 的世界书之后，每次世界书激活判定要 5 秒以上，
主线程被占满，流式输出实质停摆，严重时 `session.list` 也会超时。

用 CPU profile 采样确认，绝大部分时间花在把扫描文本复制进 QuickJS 的 WebAssembly 堆，
而这些条目的 key 全都是普通关键词，不含任何正则语法——它们本来可以用原生子串查找回答。

`src/import/lorebook.ts` 的 `regexMatches()` 只有在**没有** QuickJS runtime 时才使用原生路径：

```ts
if (matcher === undefined) {
  const matchedKeys = literalRegexMatches(keys, text, entry)
  return matchedKeys === undefined
    ? { ok: false, reason: 'regex-runtime-unavailable' }
    : { ok: true, matchedKeys }
}
const result = matcher.match(keys, text, entry.caseSensitive)   // runtime 可用就一律走这里
```

只要 runtime 起得来，每个 key 都会进 WASM：`vm.newString(text)` 把整段扫描文本复制进 QuickJS 堆，
再 `new RegExp(pattern, flags).test(text)`。正则不缓存、文本每个 key 重搬一次。

`409ba7f`（2026-08-15）之前的行为是：`useRegex` 条目一律先试 `literalRegexMatches()`，
只有真正含正则语法的 key 会被标成 `regex-unsupported`。那次改动让真正的正则可用（正确的改进），
但同时把原生快速路径挡在了后面。

### 最短复现步骤

1. 准备一本世界书，其中若干条目的 `use_regex` 为 `true`，但 keys 全是普通关键词（不含 `/` 与正则运算符）。
   从 SillyTavern 导出的世界书常常整本都是这种形态。
2. 把它挂到一个已有上百条消息的角色会话。
3. 发送一条消息，观察出字速度；或在服务端对进程采样 CPU profile。

条目数与 key 数越多、对话越长，差距越明显。本次观测的规模是 2 本书 / 59 条 / 其中 41 条 `use_regex` /
353 个参与扫描的 key / 约 206 KB 扫描文本。

### 预期行为

keys 全为字面量（`isLiteralRegexPattern()` 全部通过）的条目应使用原生子串匹配，
与 `409ba7f` 之前一致；只有真正含正则语法的 key 才需要隔离 runtime。
激活结果不应因为走哪条路径而改变。

### 本地错误或诊断

```
CPU profile（web profile 进程，流式输出中采样 15 秒）

 22.8%  newHeapCharPointer   quickjs-emscripten-core     ← 把字符串复制进 WASM 堆
 17.1%  wasm-function[165]   wasm://wasm/001eb57a
  8.8%  wasm-function[440]
  8.1%  wasm-function[77]
  5.8%  wasm-function[361]
        （wasm 合计约 46%）

最热调用栈（由内而外）
   wasm-function[...]        QuickJS 内部
   callFunction              quickjs-emscripten-core
   match                     createQuickJsRegexMatcher    src/ejs-template.ts
   regexMatches              src/import/lorebook.ts
   candidate                 src/import/lorebook.ts
   inspectLorebookWithMatcher
   inspectLorebooks
   evaluate                  src/world-engine.ts
   worldInfoProjection       src/projection.ts

等价性验证（同一份数据，353 个 key / 223 KB 扫描文本）
   走原生快速路径的条目   24 / 24（0 条仍需 QuickJS）
   命中数   原生 69  ／  QuickJS 正则 69
   结果不一致  0
```

### 相关资源与公开来源

私有资源（SillyTavern 格式世界书 JSON）。触发条件与具体内容无关，只与
「条目的 `use_regex` 为 true 但 keys 是字面量」这一形态有关。

### Agent RP 版本或提交

main `f8b98d9`（2026-08-31）。同样存在于 `4d7b6f8`，以及 `409ba7f`（2026-08-15）之后的所有版本。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small（2 共享 vCPU，持续基准 0.5 vCPU）

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：建议修法与已知行为差异

先试原生，失败才交给 runtime：

```ts
const literalMatchedKeys = literalRegexMatches(keys, text, entry)
if (literalMatchedKeys !== undefined) return { ok: true, matchedKeys: literalMatchedKeys }
if (matcher === undefined) return { ok: false, reason: 'regex-runtime-unavailable' }
const result = matcher.match(keys, text, entry.caseSensitive)
```

`literalRegexMatches()` 只在**所有** key 都通过 `isLiteralRegexPattern()` 时返回结果，
含正则语法的条目行为完全不变。

两个可观察的行为差异（都认为是修正，但仍是差异）：

1. **资源上限不再套用于纯文本 key。** QuickJS 路径有 `MAX_REGEX_INPUT_CHARS = 512 KB`、
   `MAX_REGEX_EVALUATIONS = 4096`、`MAX_REGEX_PATTERN_CHARS_PER_MATCHER = 2 MB`。
   扫描文本超过 512 KB 时旧路径回 `resource-limit`，条目**不激活**；新路径会正常命中并**激活**。
2. **大小写折叠语义。** 原生用 `toLocaleLowerCase()`，正则用 `i` 标志的 Unicode case folding。
   绝大多数字符一致，特殊情形不同（土耳其语 i/İ、德语 ß vs SS、希腊文末位 sigma）。CJK key 不受影响。

附带：纯文本条目不再可能回报 `regex-invalid` / `execution-limit` / `resource-limit`，
explainability 面板上这些条目的未激活原因会从错误变成正常的 `primary-unmatched`。

### 补充：`use_regex` 无法在界面关闭

`editableWorldInfoEntry()` 没有把 `useRegex` 列为可编辑字段，`applyEditable()` 也明确保留原值，
所以用户没有任何界面途径绕开这条路径，只能修改世界书源文件后重新导入。
如果短期内不打算改匹配路径，把 `useRegex` 开放为可编辑字段也能缓解。
