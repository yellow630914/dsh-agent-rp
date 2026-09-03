# [Bug] 楼层摘要为了取 40 个字，把整段正文跑了一遍正则

### 问题发生在哪里？

投影 / 楼层面板

### 实际发生了什么？

`src/projection.ts` 的 `floorPreview()` 先把**整段正文**折叠空白，然后才截前 40 个字：

```ts
function floorPreview(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()   // ← 整篇跑一次
  return normalized.length > FLOOR_PREVIEW_LENGTH ? `${normalized.slice(0, FLOOR_PREVIEW_LENGTH)}…` : normalized
}
```

输出只要 40 个字，成本却随消息长度线性增长。而这个函数在 `view()` 里对**每一层**
调用，`view()` 又是**每追加一个事件就被驱动一次**——串流时模型吐的每一段都是一个事件。

这与 2026-08-31 那一批里的
[`includesKey` 每个 key 都把整段对话小写化一次](../20260831_worldbook-activation-performance/02-includeskey-lowercases-scan-text-per-key.md)
是同一个形状：为了一个很小的结果，反复处理一份很大的输入。

### 最短复现步骤

1. 在一段有上百条消息、正文较长的角色会话里发送一条消息
2. 观察出字速度；或对进程采样 CPU profile

消息越长、楼层越多，差距越明显。

### 预期行为

摘要的成本应该由摘要长度决定，而不是由正文长度决定。

### 本地错误或诊断

以 HOTFIXES 记录的同一规模量测（122 条消息、约 295 KB）：

```
一次 floors 构建（整篇正规化）   0.300 ms
一次 floors 构建（先截断）       0.091 ms   (3×)
```

3× 只是这批数据的比值；真正的问题是前者随正文长度增长，后者不会。

### 相关资源与公开来源

无需私有资源即可复现。

### Agent RP 版本或提交

`986e0e6` 之后的工作区版本，2026-09-03 03:20 部署到 GCP `dsh-web` 的那一份。
由同一轮新增的楼层面板引入。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：修法

只读有界的开头，并且保留正确的省略号：

```ts
const FLOOR_PREVIEW_SCAN_LENGTH = FLOOR_PREVIEW_LENGTH * 8

function floorPreview(text: string): string {
  const truncated = text.length > FLOOR_PREVIEW_SCAN_LENGTH
  const head = truncated ? text.slice(0, FLOOR_PREVIEW_SCAN_LENGTH) : text
  const normalized = head.replace(/\s+/gu, ' ').trim()
  const points = Array.from(normalized)
  if (points.length > FLOOR_PREVIEW_LENGTH) return `${points.slice(0, FLOOR_PREVIEW_LENGTH).join('')}…`
  return truncated && normalized !== '' ? `${normalized}…` : normalized
}
```

`truncated` 这个标志是必要的：如果开头 320 个字几乎全是空白，折叠之后可能不足
40 个字，但正文其实还有更多——这时仍然要带省略号，否则摘要会谎称自己是完整的。

顺带按码位截断，摘要不会在代理对中间断开。原来的写法有同样的问题，只是中文
不会触发。
