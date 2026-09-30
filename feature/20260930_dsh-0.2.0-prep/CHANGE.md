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

## 阶段 0.2 / 0.3（未做，计划）

**0.2 隐藏楼层 UI → 「从第 N 层开始新会话」**

零件都现成：`exportSillyTavernSessionChat` + `createSillyTavernChatSeed` +
`ChatSessionLaunchRequest{kind:'chat'}` + `memory?: 'copy-active'`。缺的只有一个楼层范围参数。
匯出那个循环已经按 `text()` 过滤，`system/message` 本来就不会被导出。

DSH 0.1.7 的 `buildForkSeed` 帮不上：它保留开头砍尾巴，方向相反。

**0.3 `set-chat-hidden` / `is_hidden` 换实作**

保留脚本介面，底层从位置性 `replace` 改成覆盖层的纯隐藏。目前被这一行挡着：

```ts
// roleplay-surface-overlay.ts parseOverride
if (supersedes.length === 0 || replacements.length === 0) return undefined
```

放宽 `replacements` 为空即可，但要加判别栏位（`format: 1` 或 `mode: 'hide'`），因为
`projection.ts` 的 `applySurfaceOverride` 有个守卫要区分「纯隐藏」和「仅提示词改写」：

```ts
// 显示正则只改提示词、不上可见表层，replacements 不在这里。
// 这时丢掉原件会把整列抹掉而不是重述它。
if (moved.length === 0) return surface
```

代价：`compaction/prune` 的计量 claim 会掉（被隐藏楼层的 token 少算）。位置性 replace
与计量事件是「契约上相邻」的，改成 append 之后这个相邻性不存在了。

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
