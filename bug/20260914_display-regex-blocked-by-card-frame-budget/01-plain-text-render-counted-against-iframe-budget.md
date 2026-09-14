# [Bug] 显示正则对旧楼层失效：纯文字结果被算进了卡片框预算

### 问题发生在哪里？

显示计划 / DOM 适配器

### 实际发生了什么？

加了一条「隐藏 3 层之外的状态栏」的会话正则（`minDepth: 6`、`markdownOnly: true`）之后，
**只有最近几层生效，往上翻状态栏全都还在**。

把那段会话的真实日志拉下来重放，Host 侧**完全正确**：

```
regex.revision: 5   scripts: 1
  session 0 "隐藏 3 层之外的状态栏"  minDepth 6  markdownOnly true  placement [2]
```

覆盖层落盘了，投影折得出来，显示计划对 `depth >= 6` 的**每一列**都返回
`render/display-regex`，状态栏也确实被剥掉了。

坏的是 DOM 适配器那一道闸：

```ts
if (plan.kind !== 'render'
  || (plan.messageId !== undefined && !retainedCardFrames.has(plan.messageId)))
  restoreHostDisplay(item, original)   // ← 退回 Host 原文
```

`retainedCardFrames` 是用来限制**卡片框（隔离 iframe）**数量的，默认只保留最近
12 列（`lightFrontend.renderDepth`）。但这道闸套在了**所有** `render` 计划上，
包括完全不需要 iframe 的纯 markdown 结果。

于是一条深度受限的规则，命中的正好是**超出这个预算的旧楼层**——计划做出来了，
却被丢掉。

实测那段会话的 37 条带状态栏回复：

| | 数量 |
| --- | --- |
| 真的剥掉 | **3** |
| 被卡片框预算挡掉 | **31** |
| 依深度规则保留（depth 0/2/4） | 3 |

被挡的例子 `segments` 是 `["markdown"]`——连一个 HTML 片段都没有。

### 最短复现步骤

1. 在一段超过 12 层的角色会话里，新增一条 `markdownOnly` 的显示正则
2. 把 `minDepth` 设成大于 0 的值（例如 6），让它只作用于较旧的楼层
3. 往上翻：规则对超出 `lightFrontend.renderDepth` 的楼层不生效

任何作用于旧楼层的纯文字显示正则都会踩到，与规则内容无关。

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：采用的修法

新增 `needsCardFrame(compilation)`：**只有非 markdown 的片段才需要框**。那道闸改成
只在真的需要框时才比对预算。

```ts
if (plan.kind !== 'render'
  || (plan.messageId !== undefined && needsCardFrame(plan.compilation)
    && !retainedCardFrames.has(plan.messageId))) restoreHostDisplay(item, original)
```

预算继续限制它本来要限制的东西（iframe），而纯文字渲染不再被误伤。
同一段会话重跑：**34 剥掉、0 被挡、3 依规则保留**。

### 补充：顺带修掉的一个缓存失效

`sessionCharacterFrontend()` 每次扫描都返回新对象，让前一轮加的**显示计划跨帧缓存**
永远对不上——串流时每一帧仍然重建一次计划器。改成投影未变时返回同一个引用。
