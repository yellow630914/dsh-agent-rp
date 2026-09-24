# 状态数据脱离 MVU，状态栏改用可自定义模板（2026-09-22）

原生会话现在也有回合后状态结算，状态栏可折叠、可用自己的模板呈现。
同一目录下有需求单。完整说明见 [docs/native-state-schemes.md](../../docs/native-state-schemes.md)。

---

## 结算 Worker 本来就不认识 MVU，认识 MVU 的是它的入口

`state-settlement` Worker 只看 `plan.act.stateActions` 是否非空。绑死在变量卡上的是
**契约的来源**——`stateActionTarget` 要求会话有 MVU 状态，且世界书里有「变量更新规则」条目。

所以脱钩不是重写结算，而是给同一个字段加第二个来源：

```
resolved.mvu + 世界书规则  → engine: 'mvu-v0'
resolved.stateScheme       → engine: 'native-v0'
```

两者的 `operations` 完全相同（`replace`/`delta`/`insert`/`remove`/`move`），
候选加独立核验的流程一个字没改。Worker 侧唯一的新代码是一行节奏判断。

`applyMvuOperations` 其实是通用的 JSON 语义操作，只是历史上住在 `mvu.ts` 里。
没有把它搬家——CONTRIBUTING 写着「不增加第二套状态结算」，
复用既有实现比搬出一个新名字更符合那条约束。

## 冻结什么、不冻结什么

方案有三部分，寿命不同：

- **初始 JSON + 结算规则**：模型可见，启动时冻结成 `agent-rp/state-scheme-seed`。
  库里的条目事后改了，旧会话不受影响。
- **状态值**：`agent-rp/state` 修订，归 `roleplay:state-scheme` 所有。
- **模板**：留在库里，按方案 id 现查。**可以随便改**，旧会话重开就套上新的。

模板不进 `renderRoleplayStateContext`，也不进结算请求。这条必须守住——
否则玩家改一个模板就改了重放结果。

## 重入检测用修订号，不用逐回合标记

MVU 那边靠 `agent-rp/mvu-state` 上的 `source.turn` 判断本回合是否已结算。
原生状态没有这个字段，也不该为它造一个：**修订号已经说明了一切**。

命名空间一旦越过本回合准备的修订，只有两种可能——结算已经落盘，
或者玩家用 `rp-state` 改过。两种情况都不该再写一次，而且第二种情况下
再写会覆盖玩家的显式编辑。所以 `(live?.revision ?? 0) > current.revision` 直接返回。

## 手动重算：从基线算，不是先还原再算

最容易写错的地方。结算用 `expectedRevision` 做 CAS，上一次成功后状态已经前进。
若从**当前值**重算，`delta` 会被套用两次（体力 -10 变成 -20）。

直觉的做法是「先追加一笔还原到结算前，再重算」——两步，中间状态会被别的读者看到。
实际做法是一步：**新值从这一回合准备时的修订算起，直接写成下一个修订**。
SessionLog 只能追加，这样既不回退日志，也没有中间态。

第二个坑：`visibleReplyText()` 原来用 `foldSurface()`（第 1 层）取正文，
但回复版本切换走的是第 3 层 overlay，`foldSurface` 不认。玩家切回旧版本再重算，
读到的不是画面上那一版。改成按调用方传入的层来取：自动结算仍走 canonical surface
（不改既有行为），手动结算走 `roleplaySurfaceNodes`。

`force` 同时跳过按 `throughEventSeq` 的去重。去重是为了防止自动流程重复劳动，
显式请求恰好是相反的意图。

## 模板语言：声明式，不给 JS

需求是「先渲染模板，再把对应路径的 JSON 填上去」，同时「不依赖任何外部脚本」。
让模板跑 JS 等于把脚本请回来，所以模板只有取值、遍历、条件三种原语，
路径是 JSON Pointer。渲染是模板与状态的纯函数——没有时钟、没有随机数，
因此天然满足重放边界，也让折叠/展开时重新挂载变成零风险操作。

**取不到的路径渲染成空，不报错。** 这是刻意的：否则改一次 schema，
所有旧会话的面板都会炸。

`marked` 已经是依赖，所以 Markdown 格式没有引入新东西。三种格式最后都过
DOMPurify 进严格 CSP 的 sandbox iframe——模板来自本地库而不是角色卡，
不需要角色卡兼容层那条开了 capability 通道的外壳。

## 结算节奏只给三档

刻意没有「强制模型每回合调用状态工具」。`setStateActionAvailable` 在所有路径上
都只被设成 `false`，内联工具早就全局关闭了；就算打开，它每回合也要多写
`tool/call` 与 `tool/result` 两条 surface 事件和一列 transcript，还会打断前缀缓存。
后台 Worker 结果一样，代价低一个量级。

「仅手动触发」仍然准备契约——不准备的话，手动重算就没有基线可用。

## 楼层与聊天记录：验过，没动

结算写的全是没有 `surfaceOp` 的插件事件，五层投影都看不见。
内联工具的 `tool/result` 确实进第 1、2 层，但 `surfaceRole()` 对它返回 `undefined`，
`floorProjection` 和 `visibleTavernMessages` 都会滤掉，**楼层编号与酒馆 `message_id` 不会错位**。

两条回归钉死这件事：结算前后 `floors` 与 `tavern.messages` 的 `messageId` 序列必须逐一相同，
`tool/result` 落盘前后同样必须相同。

## 选得到才算做完

资源提供者发布了方案，但体验选择快照原来只有 `actor`/`participant`/`worlds`/
`promptPolicy`/`regexPacks` 五个槽位——没有地方放它，等于选不到。
补了第六个槽位 `stateScheme`，一路穿过启动协议、体验选择、物化顺序到启动器的下拉框。
和 `regexPacks` 当初一样按可选字段加，旧快照解析成 `undefined`。

## 兼容与版本

- turn plan schema 5 → 6，补了向 5 的投影：原生契约整条丢掉（schema 5 的读者只可能
  通过 MVU 适配器拿到契约，把原生契约改个标签塞进去等于谎称一个不存在的来源），
  `tools.source.stateMode` 与 `tools.behavior.state` 一并去掉。
- 投影 `stateVersion` 16 → 17。
- `ROLEPLAY_RESOURCE_KINDS` 增加 `state-scheme`（加法，没有改名）。
- `toolGuidance.stateMode` 缺省解析为 `auto`，Thetail fork 写的设置照常工作。
