# 隱藏樓層改成真正生效的單向操作（2026-09-14）

隱藏樓層在 DSH 0.1.3 下等於沒作用 —— 被隱藏的樓層仍然進模型、仍然留在畫面上，
而且「上下文已用」反而變大。改回用真正的 surface `replace` 表達，並且**不再允許還原**。

同一目錄下有對應的需求單（含實測數字）。整體分層說明見
[docs/transcript-layers.md](../../docs/transcript-layers.md)。

---

## 壞在哪

0.1.1 時隱藏樓層下的是真正的 `replace`，`session.surface.nodes` 真的少掉那些節點，
**下游全部免費跟上**。0.1.3 適配時改成 `append` + `agent-rp/surface-override`，
而那是一個 **ignorable 插件事件** —— 只有 Agent RP 自己認得。

DSH 的三個消費端都不認：送給模型的 messages、token meter、append-origin 的聊天畫面。
於是隱藏樓層只改到「Agent RP 自己看的那一層」，而重新追加的副本是**淨增加**的。

實測（隱藏 50 層）：prompt 從 122,075 token 漲到 **188,245**，世界書佔用幾乎沒變。

## 改回 `replace`：當初的限制不適用於隱藏樓層

改成 overlay 的理由是 `assistant/message` 不能帶 `sourceEventSeqs`，而 `replace`
必須聲明它遮蔽的每一個節點 —— 所以**助手訊息不能當取代者**。

但隱藏樓層的取代者**不需要是助手訊息**，它只是一個標記。`user/message` 可以帶
`sourceEventSeqs`，DSH 自己的 compaction 用的正是這個寫法。重新生成必須 restate
助手回覆，所以它**仍然**只能用 overlay；隱藏樓層當初只是被順手一起搬過去了。

## 用 DSH 自己的 shadow-price 協定

和第一方的 `dsh-compaction-tool-result-pruner` 同一個寫法：

```ts
session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount })
session.append('user/message', marker, {          // 必須緊接在下一條
  surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: shadowedSeqs,
})
```

`shadowedTokenCount` 必須用 token meter **自己的估算器**算，否則它的running total 會漂移；
meter 也只認**緊鄰前一條**的 shadow-price 事件，隔一條就失效。

token meter 用 `ctx.get('tokenMeter')` **逐次呼叫時解析**，不是 `inject`：沒掛這個服務的
Host 仍然載得起來、仍然隱藏得了樓層，只是那個 bounded 計數修正不了。
沒有 meter 時**不會**補一條算不出價格的 prune —— 沒有 claim 的 `replace` 折疊成零增量，
比亂報一個價格安全。

## 標記訊息帶 plugin source

這讓它同時滿足兩件事：**模型讀得到**，而 `textContent()` 和投影都會跳過非玩家、
非模型的訊息，所以它**不會變成一個「樓層」** —— 酒館的 `message_id` 編號不會因為
隱藏而錯位，卡片腳本不受影響。

## 位置糾纏：整條重寫的退路

`replace` 是**位置**操作，而 overlay 會把取代品提到它所取代的位置上。於是可能出現
「要隱藏的樓層在原始 surface 裡排在玩家要保留的樓層後面」（例如腳本改寫過某條早期訊息）。
這時只遮蔽前綴會連保留的樓層一起吞掉，補在標記後面又會排到隊尾。

這種情況改成**遮蔽整條 surface，再按顯示順序重述每一條保留的樓層** ——
位置型 `replace` 能表達的唯一正確排列。常見情況不會觸發。

順帶的好處：既有 session 裡那些被 overlay 遮著、卻還躺在原始 surface 上的死節點，
會在下一次隱藏時一併被清掉。

## 不允許還原

`replace` 沒有反向操作，而唯一的還原方式（整條 surface 重寫）正是這個機制**唯一做不到
的事**。拿掉還原之後：

- 隱藏變成**單調**的，surface 永遠只有 `[標記, ...可見樓層]` 一種形狀，標記不會累積
- 少掉一個真實危險：原本縮小範圍是「先全部還原、再重新隱藏」**兩條獨立命令**，
  第一條成功第二條失敗時會**靜默還原掉玩家已經提交的隱藏**

**內容沒有消失** —— 它留在 SessionLog、留在 `hiddenPrefix`，所以樓層面板和「導出聊天」
都還讀得到，只是回不到模型的上下文裡。確認窗就是這樣寫的，而不是「將永久刪除」。

界面上滑桿下限綁定目前已隱藏數，按下確定會先出現一段紅字說明，按鈕文案變成
**「隱藏 N 層（不可還原）」**，沿用清空記憶那一版「按鈕自己說清楚它做什麼」的做法。

卡片腳本呼叫 `set-chat-hidden { hidden: false }` 現在會收到明確的錯誤訊息。
`rotate-chat-messages` 原本就要求「隱藏樓層恢復後才能調整順序」，現在等於這個 session
不再能調整順序 —— 已知取捨，這次不動。

## 畫面：投影新增 `shadowedSeqs`

被真正 `replace` 掉的列**沒有替身**，和 overlay 的 `supersededSeqs` 不是一回事
（後者存在是為了放過「被遮蔽但仍承載該輪唯一文字」的模型回覆，那條窄規則維持不變）。
投影新增 `shadowedSeqs`，顯示計畫對它無條件隱藏。

同時修好 DOM 轉接器：`user` 那一圈**原本完全沒處理 `hidden`**，會落到
「還原 Host 列」把它顯示回來。現在兩圈對稱。

## 改動檔案

```
 src/tavern-chat.ts                  | 133 ++   prune + replace、單向、整條重寫退路
 src/projection.ts                   |  42 ++   折疊 shadowedSeqs
 src/projection-types.ts             |   8 ++
 src/roleplay-display-plan.ts        |  17 ++   真 replace 的隱藏規則
 src/client/index.tsx                |  72 ++   單向滑桿、確認步驟、user 圈處理 hidden
 src/index.ts                        |  15 ++   逐次解析 tokenMeter
 src/tavern-helper-command.ts        |  10 ++   串接估算器
 tests/tavern-chat.test.ts           | 119 ++
 tests/projection-contract.test.ts   |  41 ++
 tests/roleplay-display-plan.test.ts |  27 ++
 docs/transcript-layers.md           | 新檔：五層投影與各自的消費端
```

## 測試

**tavern-chat**（4 條，其中 3 條新增）—— 原始 surface 真的縮短、標記在位、
`compaction/prune` 的 `shadowedSeqs`／`shadowedRange`／價格正確且**緊鄰**取代事件、
隱藏**不再重新追加任何東西**（助手事件數不變、沒有第二個 live message id）、
還原被拒、以及**腳本改寫留下死副本之後仍然隱藏得了**（走整條重寫的退路）。

**projection-contract**（1 條新增）—— 隱藏後 `shadowedSeqs` 列出那些列，投影 surface
跟著真 replace 走。

**roleplay-display-plan**（1 條新增）—— `shadowedSeqs` 的列兩種 row kind 都隱藏，
而 overlay 的 `supersededSeqs` 仍然放過承載該輪文字的模型回覆。

```
focused         746 tests (730 passed, 16 skipped)
smoke            67 passed
http             11 passed
session-launch   20 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 已有 session 的處置

**這修不了已經隱藏過的舊 session** —— 日誌只能追加，那些舊的 overlay 記錄改不了。
在那些 session 裡被隱藏的樓層仍然會顯示、仍然進上下文。

不過**再隱藏一次就會一併清乾淨**：新的 `replace` 會把那些死節點也遮蔽掉。

## 尚未驗證

滑桿、確認步驟、以及被隱藏列從畫面消失這三件事**沒有實機點過**，只過了型別檢查與
Host 端測試。建議上線後拿一個不重要的 session 隱藏兩層，確認：畫面上那兩層消失、
保留的樓層不重複、「上下文已用」下降。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
