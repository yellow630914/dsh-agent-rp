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

## 阶段 0.2：从第 N 层另开分支（本次）

`kind: 'branch'` 启动请求，`prepareAgentRpBranchSession()`。楼层面板多一个「另开分支」
按钮，复用既有的滑杆——玩家本来就在那里挑「砍掉最前面几层」。

### 继承什么

| 项目 | 怎么过去 |
| --- | --- |
| 角色卡 / 人物 / 世界书 / 预设 / 状态方案 / 提示词策略 | 留在**回合之外**的事件里，原样带过去 |
| 记忆 | `appendAgentRpMemorySeed`，带当前有效集合 |
| 正则覆盖层 / 世界书覆盖层 / 酒馆脚本状态 | 重新发一笔 `command/done`（折叠值） |
| 状态数据 | 重新发 `agent-rp/state` |
| 聊天记录 | **重新叙述**：每层一个完整回合，和导入聊天同形 |

丢失的（玩家已同意）：每层的标注、插图产物、回复版本，以及被保留楼层的 turn plan、
结算与呈现记录。楼层的文字、角色与顺序都在——和导出/导入来回一趟保住的东西一样。

### 两个不明显的坑

**一、「启动种子」不等于「第一个 turn 之前」。**角色启动会把开场白铸成一个完整回合，
**然后**才追加预设与世界书种子。所以按第一个 `turn/start` 切前缀会静默丢掉预设。
真正区分身份与记录的是**回合归属**，所以规则是 `outOfTurnSeed()`：留下所有不属于任何
回合的事件。

**二、重复套用会让状态失效。**`command/done` 是个共用载体（记忆、MVU、人物、投影都读它），
不能整类丢掉；但留着它又会和「重新发折叠值」撞车。状态数据尤其严重——修订号必须连续，
双写会直接抛 `revision is discontinuous`。所以 `carriedRoleplayConfiguration(events, kept)`
拿**完整日志的折叠**和**保留事件的折叠**对比，只有不一致才补发，而且状态的修订号接在
保留事件已建立的那个后面。

状态是以**拥有模块**的身份补发，不是玩家身份：玩家写入必须引用那笔 `rp-state` 命令事件，
而那笔事件可能正好是被丢掉的。值一样，只有归属从「玩家改的」变成「拥有它的模块建立的」。

### 与隐藏楼层的关系

两者并存，是同一个滑杆上的两个出口：

- **隐藏**改写当前会话、不可还原、模型真的看不到（真 `replace`）
- **分支**不动当前会话，砍掉的楼层留在原处可读

玩家的手动流程（导出聊天 → 总结成记忆 → 迁移聊天）现在是一个按钮。

### 未做

分支**没有**标 `isSeeded` / `inheritedEventCount`——它的种子不是父会话日志的前缀。
`parentSession` 照记，血缘还在。

DSH 0.1.7 的 `buildForkSeed` 帮不上：它保留开头砍尾巴，方向相反。

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
