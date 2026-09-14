# 对话记录的分层

一段角色扮演会话里，「聊天记录」不是一份数据，而是**五层不同的投影**，各自回答不同的问题。
它们全部由同一份 SessionLog 推导出来，但**推导规则不同，结果也不同**——
这是设计，不是 bug；真正的 bug 是某一层该跟上却没跟上。

本文说明每一层是什么、带什么字段、谁在用。渲染器那一侧（显示计划 / DOM 适配器 /
兼容运行时）见 [message-display-architecture.md](message-display-architecture.md)。

---

## 0. SessionLog：唯一的事实来源

一串**只能追加**的事件，每条带 `seq`（在日志里的位置）、`time`、`type`、`data`。
删除和修改都不存在——改变只能表达为「再追加一条」。

产生消息的三种事件（`user/message`、`assistant/message`、`tool/result`）额外带一个
`surfaceOp`，声明它怎么进入 surface：

| `surfaceOp` | 含义 |
| --- | --- |
| `'append'` | 追加到 surface 末尾 |
| `{ op: 'replace', start, end }` | 遮蔽 `[start, end]` 这段 surface，自己站进去 |

没有 `surfaceOp` 的事件不是 surface 事件（命令、投影、插件记录等）。

下面五层**全部**是这串事件的纯函数，可重放。

---

## 1. 模型可见 surface（DSH 所有）

`session.surface.nodes` — 一串 seq，**尊重 `replace`**：被遮蔽的节点不在里面。
`session.deriveMessages()` 沿着它折出 `Message[]`。

- **属性**：位置序列。每个节点就是一条 SessionLog 事件的 seq。
- **谁维护**：DSH core。
- **DSH 用它做什么**：组装发给模型的 `messages`。

## 2. 人类可读 transcript（DSH 所有）

DSH 客户端 `ui-chat` 渲染的那一列一列。它**不读 surface**，只收
**append-origin** 事件——即 `surfaceOp === 'append'` 的事件。

DSH 自己的注释说得很直白：

> The model-visible surface deliberately shadows replaced ranges, so it is the
> wrong source for a human transcript — a landed replacement would erase
> conversation the user already saw. Append-origin events are that transcript's
> durable source material; replacement copies stay model-only.

**所以第 1 层和第 2 层本来就会不一样**，而且是刻意的：模型看到的是「当前有效的历史」，
人看到的是「真的发生过什么」。`replace` 写进去的副本**只给模型看**，
不会出现在 transcript 上。

- **属性**：Chat Node。`user` 节点以事件为键；`assistant-step` 节点以
  `(turn, step)` 为键——**同一组 turn/step 的多条 assistant 事件会合并成一个节点**，
  节点的 `finalNode.seq` 是其中最后一条。
- **谁维护**：DSH `dsh-client-ui-chat`。
- **Agent RP 无法替换这一层**，只能在它渲染出来之后，逐列决定
  `host` / `hidden` / `render`（这就是显示计划做的事）。

## 3. Agent RP overlay（本插件所有）

DSH 0.1.3 起 `assistant/message` 不准带 `sourceEventSeqs`，而 `replace` 必须声明它
遮蔽了哪些节点——于是**助手消息再也不能通过 Host 遮蔽 surface**。

Agent RP 需要那个能力（回复版本、prompt-regex 改写、酒馆脚本改写楼层），
所以改成：**全部用 `append` 写入，再追加一条 `agent-rp/surface-override`
（ignorable 插件事件）记录这次取代**。

```ts
{ format: 0, supersedes: number[], replacements: number[] }
```

`readRoleplaySurfaceOverlay()` 把所有这类事件折成三样东西：

| 字段 | 含义 |
| --- | --- |
| `hidden` | 被取代、且没有再站回来的 seq |
| `promoted` | 锚点 seq → 站在它位置上的替代 seq（**替代品出现在被取代者的位置，不是末尾**） |
| `anchorOf` | 替代 seq → 它占据的锚点位置 |

读取入口有两个：`roleplaySurfaceNodes(session)`（seq 序列）和
`roleplayModelHistory(session)`（`Message[]`，`deriveMessages()` 的 overlay 版）。

> **关键限制**：这是一个 **ignorable 插件事件**。DSH 完全不认识它。
> 只有显式调用上面两个函数的代码才会跟上——第 1 层和第 2 层都不会。

## 4. Agent RP 投影 surface（本插件所有，供浏览器使用）

`AgentRpProjectionState['surface']`，折叠时同时处理 `append`、`replace` 和
`agent-rp/surface-override`（见 `applySurface` / `applySurfaceOverride`）。

每个节点带：

```ts
{ seq: number; text?: string; reasoning?: string; role?: 'user' | 'assistant' }
```

投影还单独导出两份对照表给显示计划用：

- `surfaceAnchors`：替代 seq → 锚点 seq（**只有替代品才有这一项**）
- `supersededSeqs`：被第 3 层 overlay 取代的 seq 列表
- `shadowedSeqs`：被真正的 `replace` 从 surface 上移除的 seq 列表（隐藏楼层）

两者要分开：`supersededSeqs` 里的行**有替身**站在它的位置上（重新生成的新回复），
`shadowedSeqs` 里的行**没有**——玩家要它们离开对话。显示计划因此对它们的处理不同。

## 5. 酒馆消息层（本插件所有，给卡片脚本和 UI 用）

酒馆脚本按 `message_id`（0、1、2…）寻址消息，而不是按 seq。这一层就是那份编号：

```
tavern.messages = [ ...hiddenPrefix（isHidden: true）, ...投影 surface（isHidden: false） ]
                  再按顺序编号成 messageId 0..n
```

每条带 `{ messageId, seq, role, text, isHidden, annotations? }`。

**`hiddenPrefix` 是隐藏楼层的存放处**，`{ seq, role, text }`，存在
`TavernHelperState` 里（落在 `command/done` 的结果文本，或
`agent-rp/tavern-state-attachment` 事件上）。

它是**保留但不给模型看**的一段前缀：楼层从 transcript 上撤下来之后，
酒馆 API 仍然能按原编号读到它们，脚本不会因为玩家隐藏了楼层就错位。

**楼层面板**（`floors`）是同一份数据的另一个投影：
`{ seq, role, preview, hidden }`，`preview` 是有上限的摘要（40 个码点，
最多扫 320 个字符），因为这份列表每次投影更新都要重算。

---

## 发给 AI 的到底是哪一层？

**第 1 层，不是第 3 层。**

> 这就是为什么「隐藏楼层」不能只写第 3 层。它现在改用真正的 surface `replace`
> 表达，见下面的[隐藏楼层怎么落到第 1 层](#隐藏楼层怎么落到第-1-层)。

DSH 的 agent loop 用 `deriveMessages()`（第 1 层）组好 `options.messages`，
Agent RP 只有一个接缝能改它 —— `src/prompt-regex-stream.ts` 里的 `llm/stream` 中间件：

```ts
let messages = options.messages                      // ← 第 1 层，原始
if (hasPromptScripts || hasManagedSurface) {
  const trace = applyPromptRegexSurface(agent.session, plan.transforms)
  if (trace !== undefined && trace.replacementCount > 0) messages = roleplayModelHistory(agent.session)  // ← 第 3 层
}
return { ...options, messages: prepareSillyTavernProviderMessages(messages, plan) }
```

也就是说**只有 prompt-regex 这一轮真的替换过东西，才会换成 overlay 版本**；
否则原样放行。中间件上方还有一个提前 `return undefined`，那种情况下整个中间件跳过。

`prepareSillyTavernProviderMessages()` 之后做的是在历史前后注入预设提示词、
应用续写——它不改历史本身。

**后果**：任何只靠第 3 层表达的「从模型视野里拿掉」，在 0.1.3 下都不会生效，
除非那一轮恰好有 prompt-regex 替换。

## Agent RP 自己的其它路径用哪一层？

这些**都是第 3 层**，都正确：

| 用途 | 入口 |
| --- | --- |
| 世界书扫描的对话文本 | `preRegexDialogue()` → `roleplayModelHistory()` |
| 预设宏（`{{lastMessage}}` 等） | `macroMessages()` → `roleplayModelHistory()` |
| 外部上下文绑定 | `bindRoleplayExternalContext({ visibleMessages })` |
| 故事引擎、酒馆生成 HTTP、世界书角色上下文 | 同上 |

所以会出现一个别扭的组合：**世界书按「隐藏后的历史」扫描，模型却收到「隐藏前的历史」**。

## 画面上显示的是哪一层？

**第 2 层渲染，第 4 层决定怎么改它。**

DSH 先把 append-origin 事件铺成一列列，Agent RP 的显示计划
（`src/roleplay-display-plan.ts`）再逐列返回：

- `host` — 保留 DSH 原样
- `hidden` — 这一列不该出现
- `render` — 用 Agent RP 渲染的内容替换

显示计划只读第 4 层（`shadowedSeqs` / `supersededSeqs` / `surfaceAnchors` /
`generations`）和第 5 层（`tavern.messages`，用来取 `messageId` 和正则深度）。

DOM 适配器再把计划落到页面上，`user` 和 `assistant-step` 两条循环都要处理 `hidden`
——第 2 层不会自己把任何一列拿掉。

## 「上下文已用」是哪一层？

**第 1 层，而且没有任何接缝。**

那是 DSH 的 `dsh-token-meter`（`contextBreakdown.messageTokens`），
它折的是 SessionLog 里的 surface `append` 和 `replace`。

它**看不到 `agent-rp/surface-override`**，而且没有任何接缝可以告诉它——只认
`compaction/summary` / `compaction/prune` 这两个紧邻 `replace` 的 shadow-price 事件。
所以任何只写第 3 层的改动都不会让这个数字动。

---

## 隐藏楼层怎么落到第 1 层

隐藏楼层是目前唯一需要「让某段历史真的离开模型视野」的功能，所以它**不走第 3 层**，
而是走 DSH 自己的 shadow-price 协定——和官方 `dsh-compaction-tool-result-pruner`
同一个写法：

```ts
session.append('compaction/prune', {
  shadowedRange: { start, end },
  shadowedSeqs,                                  // 这段 surface 的每一个节点
  shadowedTokenCount,                            // 用 ctx.tokenMeter 的估算器算
})
session.append('user/message', marker, {         // 必须紧接在下一条
  surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: shadowedSeqs,
})
```

两个约束决定了这个形状：

- `assistant/message` **永远不能带 `sourceEventSeqs`**，而 `replace` 必须声明它遮蔽
  的每一个节点——所以取代者只能是 `user/message` 或 `tool/result`。隐藏楼层的取代者
  只是一个标记，不需要是助手消息，所以这条限制对它不成立。（重新生成必须restate
  助手回复，所以它**仍然**只能用第 3 层的 overlay。）
- token meter 的 O(1) 投影只能从**紧邻前一条**的 shadow-price 事件里拿到被遮蔽区段
  的价格，否则它「以零增量折叠」——数字不会跟着降。

标记消息带 **plugin source**，这让它同时满足两件事：模型读得到它，而
`textContent()` 和投影都会跳过非玩家、非模型的消息，所以它不会变成一个「楼层」，
酒馆的 `message_id` 编号不会因为隐藏而错位。

**隐藏是单向的。** `replace` 没有反向操作，唯一的还原方式是把整条 surface 重写一遍。
被隐藏的文字并没有消失——它留在 SessionLog、留在 `hiddenPrefix`，因此楼层面板和
导出聊天都还读得到——只是**回不到模型的上下文里**。

### 位置纠缠与整条重写

`replace` 是**位置**操作，而第 3 层会把取代品提到它所取代的位置上。于是可能出现
「要隐藏的楼层在原始 surface 里排在玩家要保留的楼层后面」。这时只遮蔽前缀会连保留的
楼层一起吞掉，而把它们补在标记后面又会排到队尾。

这种情况下改成**遮蔽整条 surface，再按显示顺序重述每一条保留的楼层** ——
位置型 `replace` 能表达的唯一正确排列。代价是那些楼层会以新的消息身份重新落盘
（内容和来源不变）。常见情况下不会触发。

## 一张表

| 层 | 谁所有 | 尊重 `replace` | 尊重 overlay | 用在哪 |
| --- | --- | --- | --- | --- |
| 1 模型 surface | DSH | ✔ | ✘ | **发给模型的 messages**、上下文已用 |
| 2 人类 transcript | DSH | ✘（刻意） | ✘ | 画面上的一列列 |
| 3 Agent RP overlay | 本插件 | ✔ | ✔ | 世界书扫描、宏、外部上下文 |
| 4 投影 surface | 本插件 | ✔ | ✔ | 显示计划、楼层面板 |
| 5 酒馆消息层 | 本插件 | ✔ | ✔ | 卡片脚本 `message_id`、隐藏前缀 |

## 由此推出的规则

1. **要让模型看不到某条消息**，只改第 3 层不够 —— 第 1 层才是真的发出去的那份。
   唯一可靠的做法是让它不进入 surface，或者进入后被真正的 `replace` 遮蔽
   （隐藏楼层就是后者）。
2. **要让画面上看不到某一列**，必须走显示计划的 `hidden`，并且 DOM 适配器两条循环
   都要处理它。第 2 层不会自己消失——它按设计就保留所有 append-origin 事件。
3. **「上下文已用」只会跟着第 1 层**。第 1 层不变，那个数字就不会变。
4. **第 2 层和第 1 层不一致是正常的**。不正常的是第 1 层没有反映玩家的意图。

## 0.1.1 → 0.1.3 变了什么

| | 0.1.1 | 0.1.3 |
| --- | --- | --- |
| 取代的表达方式 | 真正的 surface `replace` | `append` + `agent-rp/surface-override` |
| 第 1 层跟上吗 | ✔ 自动 | ✘ 除非 prompt-regex 那条接缝触发 |
| 第 2 层跟上吗 | ✘（append-origin，本来就不跟） | ✘ 同样不跟 |

隐藏楼层已经改回真正的 `replace`（见上一节），所以第 1 层和「上下文已用」重新跟上；
第 2 层永远不会自己跟上，由显示计划的 `shadowedSeqs` 规则负责。**重新生成、prompt-regex
这些必须restate 助手回复的路径仍然只能用 overlay**，它们的第 1 层依旧只在
prompt-regex 接缝触发时才跟上。

换句话说：**0.1.1 下「拿掉一段历史」这件事只需要写对一处，下游自动跟上；
0.1.3 下它变成了每个消费端各自要处理的事，而 DSH 那两个消费端我们改不到。**

这是隐藏楼层、以及任何依赖「取代」的功能在 0.1.3 下需要重新设计的根本原因。
