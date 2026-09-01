# [Bug] 世界书扫描文本在每个条目重新构建一次

### 问题发生在哪里？

世界书或 EJS

### 实际发生了什么？

`src/import/lorebook.ts` 的 `candidate()` 里，扫描文本是逐条目构建的：

```ts
const depth = entry.scanDepth ?? bookDepth ?? messages.length
const text = depth === 0 ? '' : messages.slice(-Math.max(0, Math.trunc(depth))).join('\n')
```

这段代码位于 `inspectLorebookWithMatcher()` 的 `book.entries.map(...)` 内，**per entry** 执行。
没有任何条目覆写 `scanDepth` 时（常见情形），一本 24 条参与扫描的书会重建 24 份
一模一样的百 KB 级字符串。

在 CPU profile 里表现为 `candidate()` 自身占用异常高，加上明显的 GC 压力——
而 `candidate()` 除了组装决策对象之外并没有别的工作。

### 最短复现步骤

1. 准备一本有数十个条目的世界书，条目**不要**单独设置 `scanDepth`（让它们回退到同一个深度）。
2. 挂到一个已有上百条消息的角色会话。
3. 发送一条消息，对服务端进程采样 CPU profile，观察 `candidate()` 的 self time 与 GC 占比。

本次观测规模：24 个参与扫描的条目 / 122 条消息 / 约 206 KB 扫描文本。

### 预期行为

同一次激活判定内，相同 `(messages, depth)` 的扫描文本只需要构建一次。
条目自定义 `scanDepth` 时才需要重新构建。

### 本地错误或诊断

```
CPU profile（web profile 进程，流式输出中采样 15 秒；已先修掉 QuickJS 与重复小写化两项）

 38.1%  includesKey                          key 比对
 21.0%  (anonymous)  inspectLorebookWithMatcher 的 entries.map
 19.7%  candidate                            ← 扫描文本构建
  4.8%  (garbage collector)
  3.6%  approximateTokens

微基准（24 个条目 / 122 条消息 / 206 KB）
  每个条目各自 slice + join    100.7 ms
  按 (messages, depth) 缓存      0.50 ms
```

### 相关资源与公开来源

私有资源（SillyTavern 格式世界书 JSON）。与内容无关，只与条目数和消息总长度有关。

### Agent RP 版本或提交

main `f8b98d9`（2026-08-31）。自 `4c74c23`（2026-08-13）引入激活判定起即为此形态。

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

---

### 补充：建议修法

以 `(messages, depth)` 为键的单槽缓存：

```ts
let scanTextMessages: readonly string[] | undefined
let scanTextDepth: number | undefined
let scanTextValue = ''

function scanText(messages: readonly string[], depth: number): string {
  if (scanTextMessages === messages && scanTextDepth === depth) return scanTextValue
  scanTextMessages = messages
  scanTextDepth = depth
  scanTextValue = depth === 0 ? '' : messages.slice(-Math.max(0, Math.trunc(depth))).join('\n')
  return scanTextValue
}
```

`messages` 在一次 `inspectLorebooks()` 内是同一个数组引用，所以引用相等就能命中；
条目自定义 `scanDepth` 时键会变，正确回退到重建。输出等价性已用
`depth` = 0 / 1 / 3 / 5 / 99 验证，与原式完全一致。这是纯优化，行为不变。

### 补充：为什么这项值得单独修

这一项比 key 比对本身（预热后约 22 ms）更贵。修掉之后，
「调小 `scanDepth` 换速度」就不再必要——那个做法会减少被激活的条目
（实测：全文命中 67 个 key，`scanDepth=10` 只剩 41 个），等于让用户拿角色扮演的一致性换性能。
纯实现层面的修正不应该要求用户付这个代价。
