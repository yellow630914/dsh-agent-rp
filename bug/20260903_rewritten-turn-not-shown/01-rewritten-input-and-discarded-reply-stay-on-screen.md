# [Bug] 修改输入并重新生成之后，界面上旧的输入与输出都还在

### 问题发生在哪里？

对话界面 / 回复版本

### 实际发生了什么？

用「修改输入并重新生成」改写最后一轮之后，界面上同时出现三样东西：
**旧的输入、旧的输出、新的输出**。新的输入完全没有出现。

导出聊天是正确的，模型收到的也是正确的——只有界面不对。

从服务器上的真实会话（2026-09-03 14:07 UTC）看，Host 侧完全正确：

```
14:01:01 seq=89463  user/message       append              len=37    ← 旧输入
14:01:25 seq=91606  assistant/message  append              len=2268  ← 旧输出
14:07:43 seq=91614  user/message       replace 89463-91606 len=62    ← 新输入（遮蔽两者）
14:07:43 seq=91619  user/message       append  src=plugin  len=241   ← 生成指令
14:07:58 seq=93288  assistant/message  append              len=1968  ← 新输出
14:08:04 seq=93295  assistant/message  replace 91619-93288 len=1968  ← 收敛
```

表层最后只剩 `91614` 与 `93295`，所以导出是对的。

### 根因

`dsh-client-runtime` 用 `isAppendSurfaceEvent()` 构建人类逐字稿，**只收
`surfaceOp === 'append'` 的事件**。它自己的注释说明了理由：

> The model-visible surface deliberately shadows replaced ranges, so it is the
> wrong source for a human transcript — a landed replacement would erase
> conversation the user already saw. Append-origin events are that transcript's
> durable source material; replacement copies stay model-only.

所以替换节点**永远不会**成为一行。对照上面的事件：

| seq | append-origin？ | 界面 |
| --- | --- | --- |
| 89463 旧输入 | 是 | 显示 ← 不该显示 |
| 91606 旧输出 | 是 | 显示 ← 不该显示 |
| 91614 新输入（replace） | 否 | 不显示 ← 该显示 |
| 93288 新输出 | 是 | 显示 |

`regenerate` 之所以正常，是因为 Agent RP 自己的显示规划器认得**版本群组**：
`finalSeq !== generation.anchorSeq` 的行会被隐藏，锚点那行改渲染选中版本的文字。
而 `rewrite-input` 当初刻意**不写版本群组**（因为要求是「直接删除旧输出，
不保留为版本」），规划器就没有任何依据。

还有第二层：`planUserRow` 在没有显示正则规则时直接返回 `{ kind: 'host' }`，
也就是照原文渲染。所以就算行数对齐修好，玩家那一行仍然会显示旧文字。
酒馆脚本用 `setChatMessages` 改用户消息应该有同样的现象——这是既有限制。

### 最短复现步骤

1. 在角色会话里完成一轮对话
2. 在该轮的「更多操作」里选「修改输入并重新生成」，改写输入并确认
3. 观察沉浸视图

### 预期行为

那一轮读起来应该是一次完整的交换：新的输入 + 新的输出，旧的两者都不出现。

### 相关资源与公开来源

无需私有资源即可复现。

### Agent RP 版本或提交

`e127dc2`，2026-09-03 03:20 部署到 GCP `dsh-web` 的那一份。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：修法

「让新节点出现」这条路走不通——那是 Host 逐字稿刻意的设计。能做的只有
Agent RP 自己的显示层，也就是 `regenerate` 已经在做的事：
**把原本那两行当锚点，把内容换成新的。**

1. `rewrite-input` 改为写一条版本群组记录：
   - `anchorSeq` = 被丢弃的那条回复（逐字稿上真实存在的行）
   - `versions` 只有一条 = 新回复。**单版本意味着不会出现版本切换箭头**，
     旧回复是被丢弃而不是停在箭头后面，符合原本的要求
   - 新增字段 `rewrittenInput: { seq, text }`，记录被取代的玩家行与替换文字

2. `roleplay-display-plan.ts` 的 `user()` 分支新增一条规则：
   若这一行的 seq 在 `rewrittenInput` 里，就渲染替换文字，
   **并且不受 `hasDisplayRules` 限制**——这一行的原文已经不该出现，
   没有显示规则时也必须纠正。

   这条计划刻意**不带 `messageId`**：DOM 适配器对带 `messageId` 的渲染计划
   会按卡片框保留深度做门槛，落到门槛外就退回 Host 渲染，也就是又把旧文字
   显示出来。对一行玩家输入来说，丢掉卡片框身份远比显示错内容轻。

### 补充：为什么 `originSeq` 是新回复而不是旧回复

`parseGenerationState()` 要求 `versionSeqs[0] === data.originSeq`。既然版本列表
只有新回复这一条，`originSeq` 就必须是它。`anchorSeq` 是另一个字段，
指向逐字稿上要被改写的那一行——两者本来就分开，这里正好用上。
