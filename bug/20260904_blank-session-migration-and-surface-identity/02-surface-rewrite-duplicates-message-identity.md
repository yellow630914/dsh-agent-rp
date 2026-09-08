# [Bug] 表层重写复制了消息身份，之后每一轮都失败

### 问题发生在哪里？

酒馆聊天变更 / 回合准备

### 实际发生了什么？

成功隐藏楼层之后，下一轮直接失败：

```
本轮运行失败
Roleplay external context "989c9182-d17f-438d-bc37-39708c5645f5" is unavailable or ambiguous
```

服务器上那个会话的统计，错误里那个 id **确实出现了两次**：

```
plugin user 消息 : 5   不重复 id: 4
重复 id 数        : 1
   989c9182-d17f-438d-bc37-39708c5645f5 x 2
```

而且这个失败是**持续的**——只要那两个事件都还在日志里，索引就一直有歧义。

### 根因

隐藏与恢复都会走 `rewriteSurface()`，它把表层项目全部重新追加。而
`appendEntry()` 对既有项目是原封不动地重送 `event.data`：

```ts
if (event.type === 'user/message') return agent.session.append(event.type, event.data, intent)
```

`event.data` 里带着 `id`。但 `dsh-llm` 的契约说的恰恰相反——`createUserMessage`
的签名是 `id?: never`，文档写「a fresh stable identity」。也就是重新追加**绕过了
工厂**，让日志里出现两个声称同一身份的消息。

于是 `roleplay-turn-context.ts` 以 id 建索引时撞到重复：

```ts
if (candidates.has(id)) duplicateIds.add(id)
...
if (event === undefined || duplicateIds.has(messageId)) {
  throw new Error(`Roleplay external context ${JSON.stringify(messageId)} is unavailable or ambiguous`)
}
```

同样形状的读取者还有两处会中招：`session-roleplay-turn-plan.ts`（pending message）
与 `roleplay-staged-state-settlement.ts`（player input）。

### 最短复现步骤

1. 在一段含 plugin 来源用户消息（外部上下文、通知类消息）的角色会话里
2. 用楼层面板隐藏最前面几层
3. 发送下一条消息

### 预期行为

表层重写不应该让任何 id 出现两次；重写产生的是新的消息事件，就该有新的身份。

### Agent RP 版本或提交

`2966d50` 及此前所有版本。这一条不是楼层面板引入的——`rewriteSurface()`
一直是这样，只是过去只有酒馆脚本的 `/hide`、`delete`、`rotate` 碰得到，
楼层滑杆把它变成了用户随手就会踩到的路径。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：修法

重新追加时用工厂重建消息，取得新身份；**来源与内容照旧保留，只重铸身份**：

```ts
if (event.type === 'user/message') {
  return requireSurfaceEvent(agent.session.append(event.type, createUserMessage({
    content: event.data.content,
    source: event.data.source,
  }), intent))
}
```

assistant 消息同样处理（照 `generation.ts` 的 `replacementMessage()` 的写法，
把 `source` 的 `kind` 去掉再交给 `createAssistantMessage`）。

`tool/result` **刻意不动**：它的关联是 `toolCallId` 而不是消息 id，也没有读取者
按身份索引它——在没有真实故障佐证之前，不去扰动工具调用的配对。

### 补充：已经中招的会话

修补之后，新的隐藏／恢复不会再制造重复。但**已经存在于日志里的那一对重复 id
不会消失**，那个会话仍然会在准备回合时失败。要恢复，需要让那条外部上下文消息
不再进入可见范围——例如再调整一次隐藏范围把它移出表层，或从该轮之前另开分支。
