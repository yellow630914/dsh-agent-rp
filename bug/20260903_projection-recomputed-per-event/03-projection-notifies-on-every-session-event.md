# [Bug] 投影在每个事件都产生新 state，只为了一个当下没人读的时间戳

### 问题发生在哪里？

投影 / 性能

### 实际发生了什么？

`src/projection.ts` 的 `apply()` 第一行是：

```ts
const replayState = state.replayTime === event.time ? state : { ...state, replayTime: event.time }
```

而所有「这个事件与本单元无关」的路径最后都 `return withSurface`，也就是 `replayState`
——一个**仅仅因为时间戳而新建**的对象。

投影框架用 `apply()` 返回的 state 引用决定要不要做下游工作，契约写得很明确：

> A unit uninterested in an event MUST return the same state reference —
> an unchanged reference (`Object.is`) produces zero downstream work.
>
> `onChanged` … called once per client-visible unit whose **state reference**
> changed, per committed event.

所以事件时间一变，Agent RP 就宣告「我变了」，框架就驱动 `view()`、跑 schema 校验、
序列化整份 payload、送到浏览器。串流时模型吐的每一段都是一个事件，
2026-08-31 在真实会话上实测是**每轮 6849 次**。

`replayTime` 的用途只有一个：给 World Info 面板的 EJS 沙箱一个可重放的
`Date.now()`（`ejs-template.ts` 里的 `ReplayableDate`）。它只有一个读取点，
`projection.ts` 的 `templateOptions`。而且——

**`worldInfoCacheSignature` 刻意不包含 `replayTime`。** 2026-08-31 那次修补
已经决定「replayTime 变了不应该让世界书视图失效」。也就是说，这个时间戳在
被驱动的那一刻根本没有人读它。

### 最短复现步骤

1. 在一段有上百条消息的角色会话里发送一条消息
2. 观察出字速度

会话越长、`tavern.messages` 越大，每个事件重送的代价越高。

### 预期行为

与本单元无关的事件应该返回同一个 state 引用，让框架跳过全部下游工作。

### 本地错误或诊断

造一段真实形状的事件流（40 个表层事件，之间插入时间各异的惰性事件，
总数 6840，贴近 8/31 实测的 6849）：

```
                                修复前   修复后
apply() 返回新引用的次数         6840      40
                                        ↑ 正好是真正改变状态的事件数
```

也就是 `view()` 从每轮 6840 次降到 40 次，`tavern.messages` 那份带**每条消息
完整正文**的 payload 也从 6840 次降到 40 次。

### 相关资源与公开来源

无需私有资源即可复现。

### Agent RP 版本或提交

`e127dc2`，以及此前所有版本——这一条不是新引入的，
[2026-08-31 给世界书视图加缓存](../20260831_worldbook-activation-performance/04-world-info-view-recomputed-on-every-session-event.md)
治的是这个根因的一个症状。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：修法

把 `apply()` 的主体抽成模块级的 `foldAgentRpProjectionEvent()`，让它直接吃 `state`
（不再预先盖时间戳），外面包一层只在真的变了才盖：

```ts
apply(state, event) {
  const next = foldAgentRpProjectionEvent(state, event)
  return next === state ? state : { ...next, replayTime: event.time }
}
```

内部只有开头 6 行引用过 `replayState`，其余全部走 `withSurface`，
所以这是一次机械改写。

### 补充：唯一的行为差异

EJS 的 `dateNow` 变成「最后一个**改变状态**的事件时间」，而不是「最后一个事件时间」。

这不是新的不一致。世界书视图本来就跨串流被缓存，EJS 早就是拿缓存未命中那一刻的
`replayTime` 在跑。修正后两者反而对齐了：`view()` 执行时看到的一定是「触发这次
执行的那个事件」的时间。

### 补充：为什么这条修完，`tavern.messages` 就不用动了

`tavern.messages` 带每条消息的完整正文，看起来是最肥的一项，但那些正文是真的
有人要——`st-extension-host.ts` 用它喂 `SillyTavern.chat`，`tavern-runtime.ts`
的 `getChatMessages()` 读它，`card-display.tsx` 和 `roleplay-display-plan.ts`
也读它。砍掉正文等于砍掉酒馆兼容层。

问题从来不是它多大，而是它在没变的时候还一直重送。这条修完之后，
它每轮只送 40 次而不是 6840 次，`floors` 那 20.8 KB／次也一起解决。
