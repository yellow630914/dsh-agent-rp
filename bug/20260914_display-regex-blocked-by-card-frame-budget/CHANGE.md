# 顯示正則對舊樓層失效：純文字結果不該佔卡片框預算（2026-09-14）

回報「正則沒生效」。加了一條「隱藏 3 層之外的狀態欄」的會話正則之後，只有最近幾層
生效，往上捲狀態欄全都還在。

同一目錄下有對應的問題單。會話級正則那一輪見
[feature/20260914_session-regex-and-archive](../../feature/20260914_session-regex-and-archive/CHANGE.md)。

---

## 先證明不是新功能寫錯

把那段 session 的真實日誌拉下來重放，**Host 側完全正確**：

```
regex.revision: 5   scripts: 1
  session 0 "隐藏 3 层之外的状态栏"  minDepth 6  markdownOnly true  placement [2]
```

覆蓋層落盤了、投影折得出來、顯示計畫對 `depth >= 6` 的每一列都回傳
`render/display-regex`，狀態欄也確實被剝掉了。**計畫是對的，是計畫被丟掉了。**

這一步值得記下來：先把三層（覆蓋層 → 投影 → 顯示計畫）各自驗過，才有辦法把問題
收斂到最後那一道 DOM 閘上。

## 真正的原因

```ts
if (plan.kind !== 'render'
  || (plan.messageId !== undefined && !retainedCardFrames.has(plan.messageId)))
  restoreHostDisplay(item, original)   // ← 退回 Host 原文
```

`retainedCardFrames` 限制的是**卡片框（隔離 iframe）**的數量，預設只保留最近 12 列
（`lightFrontend.renderDepth`）。但這道閘套在了**所有** `render` 計畫上，包括完全
不需要 iframe 的純 markdown 結果。

於是一條深度受限的規則，命中的正好是**超出這個預算的舊樓層** —— 這不是巧合，
`minDepth` 的用途就是只作用於較舊的樓層，所以**任何這種規則都必然踩中**。

實測那段 session 的 37 條帶狀態欄回覆：

| | 修前 | 修後 |
| --- | --- | --- |
| 真的剝掉 | **3** | **34** |
| 被卡片框預算擋掉 | **31** | **0** |
| 依深度規則保留 | 3 | 3 |

被擋的例子 `segments` 是 `["markdown"]` —— 連一個 HTML 片段都沒有。

## 修法

新增 `needsCardFrame(compilation)`：只有非 markdown 的片段才需要框。那道閘改成
**只在真的需要框時**才比對預算。

預算繼續限制它本來要限制的東西，而純文字渲染不再被誤傷。這也讓那個限制的語意
回到它名字說的樣子 —— 它叫 card **frame** retention，不是 render retention。

## 順帶修掉的一個快取失效

`sessionCharacterFrontend()` 每次掃描都回傳新物件，讓 `2b011ff` 加的**顯示計畫跨幀
快取**永遠對不上 —— 串流時每一幀仍然重建一次計畫器。改成投影未變時回傳同一個參照。

這是我自己在上一輪造成的：加快取的同時，又在旁邊種了一個讓它必然失效的新物件。

## 改動檔案

```
 src/card-display-compiler.ts        needsCardFrame()
 src/client/index.tsx                兩圈的閘改成只在需要框時比對；穩定 frontend 參照
 tests/card-display-compiler.test.ts 回歸測試
```

## 測試

新增一條：markdown-only 的結果**不佔**預算，含 `inline-html` 或 `html` 片段的**才佔**，
空結果也不佔。

```
focused         755 tests (739 passed, 16 skipped)
smoke            67 passed
http             11 passed
session-launch   20 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 驗證

**已實機確認生效。** 那條「隱藏 3 層之外的狀態欄」的規則現在在整段歷史上都作用，
最新 6 層保留狀態欄。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
