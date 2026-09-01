# [Bug] `includesKey()` 对每个 key 重新小写化整段扫描文本

### 问题发生在哪里？

世界书或 EJS

### 实际发生了什么？

世界书激活判定的 CPU 有 91% 落在 `includesKey()`，而它做的只是「这段文本里有没有这个词」。

原因是 `src/import/lorebook.ts` 里的这一行：

```ts
function includesKey(text: string, key: string, caseSensitive: boolean, matchWholeWords: boolean): boolean {
  if (key.length === 0) return false
  const haystack = caseSensitive ? text : text.toLocaleLowerCase()   // ← 每个 key 都重算
  const needle = caseSensitive ? key : key.toLocaleLowerCase()
```

`text` 是整个扫描窗口（未设 `scanDepth` 时就是整段对话），而 `includesKey()` 是 **per key** 调用的。
一次激活判定有几百个 key，就是对同一份文本做几百次 locale 敏感的小写化，
产生的中间字符串全部立即丢弃。

`needle` 的小写化可以忽略（key 很短），成本全在 haystack。

### 最短复现步骤

1. 准备一本条目较多的世界书，keys 合计数百个，条目不要设置 `caseSensitive`。
2. 挂到一个已有上百条消息的角色会话（扫描文本达到百 KB 级）。
3. 发送一条消息，对服务端进程采样 CPU profile。

本次观测规模：353 个 key / 约 206 KB 扫描文本。

### 预期行为

同一次激活判定内，扫描文本只需要小写化一次。
`toLocaleLowerCase()` 对同一输入是确定性的，重复计算没有任何语义价值。

### 本地错误或诊断

```
CPU profile（web profile 进程，流式输出中采样 15 秒，19229 个样本）

 91.0%  includesKey          src/import/lorebook.ts
  4.7%  (garbage collector)
  1.8%  candidate            src/import/lorebook.ts

微基准（同一份数据，353 个 key / 206 KB 文本）
  每个 key 各自小写化   一次激活判定 5018 ms   命中 69
  文本只小写化一次      一次激活判定  227 ms   命中 69   ← 单次冷测量
                        重复三次取平均约 22 ms          ← 预热后的稳定值
```

### 相关资源与公开来源

私有资源（SillyTavern 格式世界书 JSON）。与内容无关，只与 key 数量和扫描文本长度有关。

### Agent RP 版本或提交

main `f8b98d9`（2026-08-31）。`includesKey()` 自 `4c74c23`（2026-08-13）引入激活判定起即为此形态。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：建议修法

单槽缓存，同一份文本只小写化一次：

```ts
let lowerCaseSource: string | undefined
let lowerCaseValue = ''

function lowerCased(text: string): string {
  if (lowerCaseSource !== text) {
    lowerCaseSource = text
    lowerCaseValue = text.toLocaleLowerCase()
  }
  return lowerCaseValue
}
```

`includesKey()` 改用 `lowerCased(text)`。一次判定内所有条目共用同一份 `text`（见另一份关于
扫描文本重复构建的问题单），所以单槽就够；字符串比较先走引用相等，命中率极高。

这是纯优化：同一函数、同一输入、记忆化，行为不变。
`matchWholeWords` 分支里的 `haystack.indexOf()` 循环同样受益，因为 haystack 不再每次重建。
