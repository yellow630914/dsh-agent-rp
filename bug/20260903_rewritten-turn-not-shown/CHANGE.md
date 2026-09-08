# 修改輸入並重新生成：畫面沒有反映改寫（2026-09-03）

回報：用「修改輸入並重新生成」之後，畫面上同時留著**舊輸入、舊輸出、新輸出**，
新的輸入完全沒出現。匯出聊天正確，模型收到的也正確 —— 只有畫面不對。

同一目錄下有對應的問題單。引入這個功能的那一輪見
[20260903_inline-regenerate-and-floor-visibility](../../feature/20260903_inline-regenerate-and-floor-visibility/CHANGE.md)。

---

## 根因：撞上 Host 逐字稿的刻意設計

從伺服器上的真實會話（14:07 UTC）看，Host 側完全正確 —— 表層最後只剩新輸入與
新輸出，所以匯出才是對的。問題在渲染。

`dsh-client-runtime` 用 `isAppendSurfaceEvent()` 建構人類逐字稿，
**只收 `surfaceOp === 'append'` 的事件**。它自己的註解說明了理由：

> The model-visible surface deliberately shadows replaced ranges, so it is the
> wrong source for a human transcript — a landed replacement would erase
> conversation the user already saw. Append-origin events are that transcript's
> durable source material; replacement copies stay model-only.

所以我的替換節點（新輸入）**永遠不會**成為一行，而舊輸入與舊輸出因為是 append
所以一直留著。

`regenerate` 之所以正常，是因為 Agent RP 的顯示規劃器認得**版本群組**：
`finalSeq !== anchorSeq` 的列會被隱藏，錨點那列改渲染選中版本的文字。
而 `rewrite-input` 當初**刻意不寫版本群組**（因為要求是「直接刪除舊輸出、
不保留為版本」），規劃器就沒有依據。

第二層：`planUserRow` 在沒有顯示正則規則時直接回 `{ kind: 'host' }`，
照原文渲染。所以玩家那一列即使對齊修好也仍會顯示舊文字。

## 修法：把原本那兩列當錨點，換掉內容

「讓新節點出現」這條路走不通。能做的只有 Agent RP 自己的顯示層，
也就是 `regenerate` 已經在做的事。

**1. `rewrite-input` 改為寫一條版本群組記錄**

- `anchorSeq` = 被丟棄的那條回覆（逐字稿上真實存在的列）
- `versions` 只有一條 = 新回覆。**單一版本代表不會出現版本切換箭頭** ——
  舊回覆是被丟棄，不是停在箭頭後面，仍然符合原本的要求
- 新增欄位 `rewrittenInput: { seq, text }`，記錄被取代的玩家列與替換文字
- `originSeq` 必須是新回覆：`parseGenerationState()` 要求
  `versionSeqs[0] === originSeq`，而版本列表只有新回覆這一條。`anchorSeq`
  是另一個欄位，指向要被改寫的那一列 —— 兩者本來就分開，這裡正好用上

**2. `roleplay-display-plan.ts` 的 `user()` 新增一條規則**

若這一列的 seq 在 `rewrittenInput` 裡就渲染替換文字，**且不受 `hasDisplayRules`
限制** —— 這一列的原文已經不該出現，沒有顯示規則時也必須糾正。

這條計劃刻意**不帶 `messageId`**：DOM 適配器對帶 `messageId` 的渲染計劃會按卡片框
保留深度設門檻，落到門檻外就退回 Host 渲染，也就是又把舊文字顯示出來。
對一列玩家輸入而言，丟掉卡片框身分遠比顯示錯內容輕。

## 結果

那一輪讀起來變成一次完整的交換：

| 列 | 之前 | 現在 |
| --- | --- | --- |
| 舊輸入 | 顯示舊文字 | 渲染**新輸入** |
| 舊輸出 | 顯示舊文字 | 渲染**新輸出** |
| 新輸出（append） | 顯示 | 隱藏 |
| 新輸入（replace） | 不顯示 | 不顯示（本來就不會是一列） |

沉浸視圖下生效，與 `regenerate` 一致；除錯視圖仍會看到全部原始列，
這也和 `regenerate` 的既有行為一致。

## 改動檔案

```
 src/generation.ts                   |  40 +++++--   群組記錄與 rewrittenInput
 src/projection-types.ts             |   5 +++      投影欄位
 src/projection.ts                   |   1 +        投影傳遞
 src/roleplay-display-plan.ts        |  32 ++++++   user 列的改寫規則
 tests/generation.test.ts            |  12 +++-     斷言錨點群組
 tests/roleplay-display-plan.test.ts |  45 ++++++   顯示規劃迴歸測試
```

顯示測試斷言：玩家列在**沒有顯示規則、且 seq 已不在表層**時仍渲染替換文字、
且不帶 `messageId`；錨點列渲染新回覆；新追加的回覆列被隱藏；
改寫輪之外的列不受影響。

`tests/generation.test.ts` 原本斷言「不寫版本群組」，那是修正前的設計，
這次一併改成斷言錨點群組的形狀 —— 它記錄了為什麼當初那樣設計，以及為什麼不行。

## 驗證

```
focused          729 tests (713 passed, 16 skipped)
smoke             66 passed
session-launch    19 passed
http              11 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 沒有回滾的理由

修正前的版本在**模型與匯出上是正確的** —— 模型收到新輸入、看不到舊回覆，
匯出也正確。壞掉的只有畫面，所以不需要回滾既有會話；已經改寫過的那一輪
在這次部署之後會自動渲染正確，因為群組記錄是這次才開始寫的……
**但 2026-09-03 14:07 那次改寫沒有留下群組記錄，所以它會維持舊樣子。**
之後的改寫才會正確。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1
```
