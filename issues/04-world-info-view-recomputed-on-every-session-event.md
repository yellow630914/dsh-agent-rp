# [Bug] 世界书激活判定在每个 Session 事件重算一次，流式输出期间等于每段输出都重算

### 问题发生在哪里？

世界书或 EJS

### 实际发生了什么？

模型回复期间主线程被占满，出字极慢。严重时整个服务失去响应：`session.list` 超时、
浏览器连接卡在 `CLOSE-WAIT`、write-behind 停止落盘（Session 记录文件在 `request/header`
之后不再更新），最后连 `SIGTERM` 都处理不了，只能被 systemd `SIGKILL`。

原因是 `src/projection.ts` 的 `worldInfoProjection()` 位于 `agentRp` 投影的 client-visible `view` 中：

```
step (dsh-agent-loop) → session.append → invokeContainedSessionObservers
  → projection drive → view → worldInfoProjection → inspectLorebooks → …
```

Host 会在每个事件 append 之后驱动 client-visible view 把新状态推给前端。
流式输出时模型吐出的每一段都是一个事件，所以**每段输出都要把整本世界书重新判定一次**：
每个条目、每个 key、扫过整个扫描窗口。

`4c74c23`（explainable world info management）之前，投影里的世界书只是一个整数
（`worldInfoCount: state.cardWorldInfoCount`）。那次改动把激活判定放进 view——功能本身是对的
（界面需要解释哪些条目被激活、为什么），代价是频率从「每回合一次」变成「每个事件一次」。

关键：**这条路径不影响发给模型的内容**。提示词组装走 `prepareRoleplayTurn()`
（`src/roleplay-turn-plan.ts`），它有自己的 `regexEngine` 与 `renderSessionLorebooks()`，
在准备每一回合时独立解析一次。`worldInfoProjection()` 的结果只喂界面面板，
以及前端兼容层给角色卡脚本的 `getWorldInfo` 快照。

### 最短复现步骤

1. 准备一本条目较多的世界书，挂到一个已有上百条消息的角色会话。
2. 发送一条消息，让模型产生一段较长的流式回复。
3. 观察服务端 CPU：整段生成期间会持续占满一个核心；
   同时对比一个没有挂世界书的会话，同样长度的回合每事件成本低一个数量级。

### 预期行为

界面面板的激活视图在**回合边界**更新即可——用户提交提示词时算一次、回复结束后算一次。
生成过程中重算不会改变发给模型的任何内容，只是让面板逐字刷新。

### 本地错误或诊断

```
每回合成本（从 Session 事件的 request/header → turn/end 计算，seq 跨距为该回合事件数）

  挂大型世界书的会话   469 s / 6849 事件 =  69 ms/事件
  未挂世界书的会话      各回合           = 10–19 ms/事件
  未修补时最坏一次     5439 s /  540 事件 = 10072 ms/事件

CPU profile（流式输出中采样 15 秒）最热调用栈（由内而外）
   includesKey / candidate / inspectLorebookWithMatcher / inspectLorebooks
   evaluate                          src/world-engine.ts
   worldInfoProjection               src/projection.ts
   view                              src/projection.ts
   drive / view                      @deepseek-ai/dsh-session-projection
   invokeContainedSessionObservers   @deepseek-ai/dsh-session
   appendAccepted / append           @deepseek-ai/dsh-session
   step                              @deepseek-ai/dsh-agent-loop

systemd（服务被拖到无法正常停止）
   dsh-web.service: State 'stop-sigterm' timed out. Killing.
   dsh-web.service: Main process exited, code=killed, status=9/KILL
   dsh-web.service: Consumed 1h 51min 12.348s CPU time
```

### 相关资源与公开来源

私有资源（SillyTavern 格式世界书 JSON）。与内容无关，条目与 key 越多、对话越长越明显。

### Agent RP 版本或提交

main `f8b98d9`（2026-08-31）。自 `4c74c23`（2026-08-13）起为此形态。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small（2 共享 vCPU，持续基准 0.5 vCPU）

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：建议修法

以「不含进行中回复内容」的签名为键缓存这个 view：

```ts
function worldInfoCacheSignature(state: AgentRpProjectionState): string {
  return [
    state.worldInfoConfiguration.revision,
    state.worldInfoConfiguration.overrides.length,
    Object.keys(state.standaloneWorldInfos).join(','),
    state.cardLorebook === undefined ? 0 : 1,
    state.character.characterName,
    state.surface.length,
    state.currentReplySeq ?? -1,
    state.tavern === undefined ? 0 : 1,
  ].join('|')
}
```

流式输出中回复是同一个 surface 节点的文本在增长，`surface.length` 与 `currentReplySeq` 都不变，
签名稳定；用户提交消息、以及回复结束时签名才改变，效果就是「输入时算一次、输出结束再算一次」。
按上面那一回合估算，判定次数从 6849 次降到约 2 次。

### 补充：取舍与已知缺口

- 世界书面板与角色卡脚本的 `getWorldInfo` 快照在流式输出期间不再实时反映进行中的回复，
  回复结束后刷新。对显示用途可接受，但**这是行为改变**，不是纯优化。
- 上面的签名只看 `state.tavern` 的有无、不看内容。若脚本在流式输出中改动 `scopes` 变量或
  `worldbookBindings`，面板要等到下一个回合边界才反映。必要时可加一个时间上限（例如最多 2 秒）作为保险。
- 更根本的做法是把激活判定移出 client-visible view，改成按需计算的独立投影，
  或只在回合边界写入。上面的缓存是不改架构的最小修法。

### 补充：放大因素

同一段时间也暴露了小机型的容量问题：2 共享 vCPU、持续基准 0.5 vCPU 的实例上，
一个进程长期占满一个核心会让整台机器（SSH、隧道、界面）一起变慢。
这不是本问题的成因，但会显著放大它的可见程度。
