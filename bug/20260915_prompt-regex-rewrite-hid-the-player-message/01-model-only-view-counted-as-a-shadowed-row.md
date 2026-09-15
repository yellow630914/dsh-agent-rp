# [Bug] 发送消息后玩家自己的那一行消失，回复直接接在上一条回复后面

### 问题发生在哪里？

投影 / 显示计划 / DOM 适配器

### 实际发生了什么？

发送消息之后：

- **刚发出的那一行不见了**
- 新的角色回复直接接在**上一条角色回复**后面，整个聊天 UI 看起来错位

可复现的会话：`魔都迷途-墨小凝 ERROR`、`魔都迷途-墨小凝 ERROR 2`、`玄元修仙-苏婉`。

日志里那一段长这样（`魔都迷途-墨小凝 ERROR`）：

```
359 user/message  surfaceOp=append                              source=user  len=92
360 agent-rp/turn-plan
361 user/message  surfaceOp={"op":"replace","start":359,"end":359}  source=user  len=92
362 assistant/message surfaceOp=append                          source=model len=3279
```

`seq 361` 是 **prompt-regex 的提示词视图**——它用一次真正的 `replace` 把玩家那条消息
换成正则处理后的版本，**只给模型看**。

两个刚落地的改动叠在一起才炸：

1. 投影新增的 `shadowedSeqs` 收集**每一次**真 `replace` 的被遮蔽区段，没有区分它是
   「玩家要求隐藏楼层」还是「模型专用视图」
2. DOM 适配器的 user 那一圈**刚补上** `hidden` 分支（在那之前它会无视 `hidden`）

于是：`359` 进了 `shadowedSeqs` → 显示计划对它返回 `hidden` → user 那一圈真的把它
藏起来。而 `361` 是 `replace` 不是 append-origin，DSH 的人类 transcript 本来就不会
渲染它——**原件被我藏了，替身从来不显示，这一行就彻底消失**。

三段会话里真 `replace` 的数量，正好对上症状：

| 会话 | 真 `replace` | 其中 prompt-regex | 被藏掉的行 |
| --- | --- | --- | --- |
| 魔都迷途-墨小凝 ERROR | 1 | 1 | 1 |
| 魔都迷途-墨小凝 ERROR 2 | 2 | 2 | 2 |
| 玄元修仙-苏婉 | **6** | 6 | 6 |

苏婉那段六行全没，所以看起来「连新的角色消息都没了」。

### 最短复现步骤

1. 用一张带 `promptOnly` 或两个标志都不勾（＝两处都作用）的正则的角色卡开一段会话
2. 发送任意一条消息
3. 自己发的那一行不会出现

任何会触发 prompt-regex 改写的卡都会踩到，与正则内容无关。

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：采用的修法

`applySurface()` 早就**跳过**带 `PROMPT_REGEX_SOURCE_MARKER` 的事件——它很清楚这类
消息不属于人看得到的那一层。`applyShadowedSeqs()` 是新写的，漏了同一道判断。

补上之后三段会话的 `shadowedSeqs` 全部归零，没有任何一行被藏。

### 补充：我本来就看见过这个数字

排查「正则对旧楼层不生效」时，我在苏婉那段的探针输出里印过
`shadowedSeqs: 6`，当时把它读成「这段会话隐藏过楼层」就跳过去了——那六个其实全是
prompt-regex 的改写。一个和当下问题无关的数字出现在眼前时，值得花一秒确认它是什么，
而不是给它安一个说得通的解释。
