# [Bug] 楼层清单在每个 Session 事件都重建一次

### 问题发生在哪里？

投影 / 楼层面板

### 实际发生了什么？

`src/projection.ts` 的 `view()` 里，`floors` 是直接构建的，没有任何缓存：

```ts
const floors = [
  ...hiddenTavernMessages.map(message => ({ ..., preview: floorPreview(message.text), ... })),
  ...visibleTavernMessages.map(message => ({ ..., preview: floorPreview(message.text), ... })),
]
```

而 `view()` 是**每追加一个事件就被驱动一次**——串流时模型吐的每一段都是一个事件。
同一个文件里，`worldInfoProjection()` 上方的注释已经把这件事写清楚了：

> The view is client-visible, so the Host drives it once per appended event —
> including every streamed chunk

这正是
[世界书面板每个事件重算一次](../20260831_worldbook-activation-performance/04-world-info-view-recomputed-on-every-session-event.md)
处理过的位置。那次给 `worldInfoProjection()` 加了签名缓存，而新增的 `floors`
没有跟上同一条约束。

### 最短复现步骤

1. 在一段有上百条消息的角色会话里发送一条消息
2. 观察出字速度

### 预期行为

楼层清单只在它真正会变的时候重建，也就是表层节点集合或隐藏前缀发生变化时。

### 本地错误或诊断

以 HOTFIXES 记录的同一规模量测（122 条消息、约 295 KB），跑真实的
`agentRpProjectionDefinition.wire.view`：

```
                        修复前      修复后
view() 一次             0.313 ms    0.0061 ms      51×
  其中 floors           ≈ 0.30 ms   （缓存命中）
× 6849 事件／轮         2.1 秒      0.042 秒
```

6849 是 2026-08-31 那次在真实会话上实测的每轮事件数。0.313 ms 里约 95% 是
`floors`——修复前它几乎就是整个 `view()` 的成本。

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

### 补充：修法与为什么引用比对是精确的

按表层与隐藏前缀的**引用**缓存：

```ts
function floorProjection(state, visible) {
  const hidden = state.tavern?.hiddenPrefix
  if (floorCacheValue !== undefined && floorCacheSurface === state.surface && floorCacheHidden === hidden) {
    return floorCacheValue
  }
  ...
}
```

这不是近似，而是精确的：

- `applySurface()` 在事件不带 `surfaceOp` 时 `return surface`，**同一个数组引用**
- 一个节点的正文在它的事件存在之后就不会再变；替换会落在一个**新的 seq** 上

所以「表层引用不变 且 隐藏前缀引用不变」⇒ 楼层清单必然完全相同。
比较两个引用是 O(1)，比 `worldInfoProjection()` 用的字符串签名还便宜。

### 补充：还没有处理的部分——payload

缓存解决的是**重算**，没有解决**重送**。投影框架用 `apply()` 返回的 state 引用
决定要不要驱动 `view()` 并把结果送到浏览器，而 Agent RP 的 `apply()` 第一行
就是 `state.replayTime === event.time ? state : { ...state, replayTime: event.time }`，
所以事件时间一变就是新引用。这就是 2026-08-31 实测到「每轮 6849 次」的原因。

`floors` 在这条通道上占 **20.8 KB／次**（122 层）。按每轮 6849 次算是 143 MB 的
额外序列化。要根治得把楼层清单从投影挪到按需拉取的 HTTP 路由（`memory-http.ts`
就是现成的样板）——面板很少打开，它不需要跟着串流走。

需要说明比例：有酒馆状态的会话里，`tavern.messages` 本来就带**每条消息的完整
正文**，同一条通道上已经是几百 KB／次，`floors` 只是多约 7%。没有酒馆状态的
会话则是从约 0.6 KB 跳到 21.4 KB。也就是说这条通道整体偏重是既有问题，
`floors` 让它更重了一点，但不是主导项。
