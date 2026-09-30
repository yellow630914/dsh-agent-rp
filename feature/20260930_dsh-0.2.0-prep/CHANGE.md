# 迁移到 DSH 0.2.0 的准备工作（2026-09-30）

目标版本 **0.2.0-rc.1**（`next`；`latest` 是 0.1.7-rc.2）。当前 `0.1.3-alpha.2`。

这个 branch 只做**减法与改写**，不动相依版本。相依升级留给下一个 branch，因为
减法做完之后要验证的面积小得多。

旧会话不迁移：玩家用 导出聊天 → 总结成记忆 → 迁移聊天 手动继承。因此
`session-format-v2-to-v3` 那个「不认 ignorable 未知事件」的洞不再是阻断项，也
不必等上游修。

---

## 为什么先做减法

`0.2.0` 引入 `system/message` 占据 surface 的 0 号节点，并加了守卫：

```
surface replace: node 0 holds the system prompt and may be rewritten only by a
system/message over exactly that node
```

agent-rp 有四处位置性 `replace`。其中三处在 index ≥ 1（对话节点），只有
`setHidden`（隐藏楼层）恒为 `startIdx === 0` —— 它刻意走 **raw** surface，因为
`replace` 是位置性的、解析不了覆盖层顺序。

减法同时解决两件事：拿掉守卫碰得到的那一处，以及拿掉 bug 密度最高的那一段。

---

## 阶段 0.1：移除回复版本的玩家指令（本次）

移除 `重新生成` / `继续生成` / `切换版本` / `修改输入并重新生成`。

玩家已经不用这四个：0.1.3 适配那一轮的 bug 尾巴几乎全在这里（重新生成后没有切换器、
切不了第二次、切版本内文空白、来回切换空白但重整会回来）。根因都是
**DOM patch × anchor 解析 × ui-chat 的 `(turn, step)` keying** 三方交互，只能手动复现。

### 保留了什么，为什么

`appendReviewedReplyVersion` 留着 —— **正文审阅 Worker（`narrativeReview`）用同一套底座**
把审阅后的回复登记成一个版本而不丢掉角色 Agent 的原文。它默认关闭，玩家的真实设置里
也是关的，但那是个独立的可选功能，不该顺手删掉。

所以留下：`appendCurrentReplySurface`、`appendState`、`readGenerationGroups`、
`agent-rp/generation-state` 事件、projection 的 `surfaceAnchors` / `supersededSeqs` 折叠、
以及导出聊天的 swipes。**覆盖层本身也留着** —— 显示正则的 assistant 改写和楼层改写都在用。

诚实记一笔：因此省下的不是「整套底座」，只是它的玩家入口。真正变小的是**手动验证面积**。

`parseGenerationState` 继续接受 `regenerate` / `continue` / `select` / `rewrite-input`
这四个 operation 值。它们没有生产者了，但指令存在期间写下的会话带着这些行，重放必须读得懂。

### 没了切换器之后

正文审阅仍然会产生两个版本并选中审阅版。玩家看不到切换入口，原文留在日志和导出里。
这其实就是「审阅」该有的语义。

### 改动

```
src/generation.ts                  781 → 326 行；移除四个 operation、generate、
                                   executeInputRewrite、parseGenerationRequest 及其死助手
src/index.ts                       移除 rp-generation 指令注册
src/agent-rp-command-protocol.ts   从指令白名单移除 rp-generation
src/client/index.tsx               GenerationTail 只留「生成插图」与「修改输入并另开分支」；
                                   移除 runGeneration、版本切换器及其 CSS；
                                   一项的「更多操作」菜单提升为直接按钮
tests/                             移除 13 条只测已删指令的用例
```

`修改输入并另开分支` 原本藏在「更多操作」菜单里，现在是直接按钮。它走
`prepareAgentRpRewriteSession` —— 复制 `turn/start` 之前的事件前缀开一个新会话，
**不改动当前会话**。这正是阶段 0.2 要沿用的形状。

### 验证

```
typecheck   host + client 通过
all         907 tests (891 passed, 16 skipped)
```

---

## 阶段 0.3：隐藏楼层避开 0 号节点（本次）

原本的计划是把 `setHidden` 换成 append + 覆盖层纯隐藏，那样根本不需要位置性 `replace`。
**做到一半发现会功能回退，已放弃。**

真正送给模型的消息是 `llm/stream` 钩子里的 `options.messages` —— DSH 从 raw surface
自己组装的那份。覆盖层只有在显示正则发生替换时才顶替它：

```ts
// prompt-regex-stream.ts:246-250
let messages = options.messages
if (!inert && (hasPromptScripts || hasManagedSurface)) {
  const trace = applyPromptRegexSurface(agent.session, plan.transforms)
  if (trace !== undefined && trace.replacementCount > 0) messages = roleplayModelHistory(agent.session)
}
```

覆盖层是 ignorable 事件，模型请求与上下文计量都不认它。`setHidden` 那段注释本来就写明了
这件事——「A real `replace` is the only thing all three follow」。

所以保留真 `replace`，只把起点从 raw index 0 挪到 `protectedSurfaceHead()` 之后。那些节点
本来就不是楼层，前缀隐藏从来也不该吞掉它们；没有系统节点的 Host 上 head 为 0，行为一字不变。
`compaction/prune` 的「契约上相邻」也因此保住。

**护栏在相依升级前无法测试**：0.1.3 的 surface 只认三种事件型别，测试里造不出
`system/message` 节点。既有的 `setHidden` 用例覆盖 head 为 0 的路径。

### 顺带发现（记录，未修）

同样的道理下，**回复版本的 supersession 也只在显示正则触发时才对模型生效**。
正文审阅 Worker 是它现在唯一的使用者，默认关闭，所以先只记录。

---

## 阶段 0.2（未做）

**隐藏楼层 UI → 「从第 N 层开始新会话」**

这是一个**新功能**，不是减法，有真实的设计面要定：新会话的出处（要不要经过聊天导入库？
要不要 attachment？）、UI 怎么选第 N 层、记忆怎么带过去。玩家的手动流程
（导出聊天 → 总结成记忆 → 迁移聊天）已经能做到同一件事，所以不值得赶工——
仓促做出来的新功能正是玩家刚要求删掉的那一类。

零件都现成：`exportSillyTavernSessionChat` + `createSillyTavernChatSeed` +
`ChatSessionLaunchRequest{kind:'chat'}` + `memory?: 'copy-active'`。缺的只有一个楼层
范围参数。导出那个循环已经按 `text()` 过滤，`system/message` 本来就不会被导出；
`readGenerationGroups` 现在返回空数组，`swipes` 退化成单元素，导出照样能用。

注意：**种子不是前缀切片而是重新合成**。事件日志的 seq 必须从 0 开始、种子事件在前，
所以「保留后半段」只能像 `createSillyTavernChatSeed` 那样重新铸造身份。
`prepareAgentRpRewriteSession`（保留前缀、砍掉 turn N 之后）和 DSH 0.1.7 的
`buildForkSeed` 都是反方向，帮不上。

---

## 酒馆相容性盘点（玩家要求：逐步降低）

玩家的方向是**降低 agent-rp 对 SillyTavern 的相容度**，所以每一处「只为了酒馆相容而存在」
的行为都打上可 grep 的标记：

```
// TAVERN-COMPAT(<id>): <这是什么> | 移除后果: <会坏掉的东西>
```

盘点方式：

```bash
grep -rn "TAVERN-COMPAT(" src/
```

迁移完成后要按这份清单逐项决定去留。**0.3 是第一个挂标记的对象**，因为它是
「玩家不用、但第三方脚本会调用」的典型 —— 这一类正是要先拿掉的。

已知的酒馆脚本介面（`tavern-helper.ts` 的 operation 列表，15 个）：

```
bind-character-worldbooks   bind-chat-worldbook        bind-global-worldbooks
create-chat-messages        delete-chat-messages       delete-worldbook
replace-installed-extension-prompts                    replace-message-annotations
replace-script-injections   replace-script-status-panel replace-script-trees
replace-worldbook           rotate-chat-messages       set-chat-hidden
set-chat-messages
```

这份列表本身还不是盘点结论 —— 有些（世界书绑定）是 agent-rp 自己的核心功能，
只是沿用了酒馆的名字；有些（`set-chat-hidden`）才是纯相容负担。迁移完成后逐项判定。

---

## 本地验证

DSH 0.1.3-alpha.2 dev host 跑在 **3081**，用的是 `~/.dsh` 的**复本**
（`scratchpad/dsh013-home`），玩家自己的 3080 host 未受影响。

```
3080  PID 48696   玩家自己的（未动）
3081  PID 24884   这个 branch
```

scratchpad 被临时档清理器扫过一轮（所有 `package.json` 与 `.json` 被删、`node_modules`
留着），所以 profile 的 `package.json` / `cordis.yml` / `pnpm-workspace.yaml` 和
`.agent-presets/agent-rp/` 都重建过。`pnpm pack` 会被 `prepack` 的
`check:tavern-vendor` 挡下来（**这是既有状态，不是本次改动造成的**——把工作树 stash
掉之后一样是 stale），所以改用 `npm pack --ignore-scripts`。
