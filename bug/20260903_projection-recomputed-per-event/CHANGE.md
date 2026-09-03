# 出字變慢的修正（2026-09-03）

2026-09-03 03:20 部署之後回報出字變慢。追下去有**三個成因**，兩個是我當天新增的
樓層面板引入的，第三個是既有的、範圍大得多的根因。

同一個目錄下有三份問題單。引入前兩項的那一輪見
[20260903_inline-regenerate-and-floor-visibility](../../feature/20260903_inline-regenerate-and-floor-visibility/CHANGE.md)。

三者都在同一個位置：投影的 `view()`，而它是**每追加一個事件就被驅動一次**的東西。
註解就寫在同一個檔案裡：

> The view is client-visible, so the Host drives it once per appended event —
> including every streamed chunk

2026-08-31 在真實會話上實測是**每輪 6849 次**。

---

## 三個成因

| # | 問題 | 我引入的？ |
| --- | --- | --- |
| 1 | [摘要為了取 40 字，把整段正文跑一遍正則](01-floor-preview-normalizes-whole-body.md) | 是（09-03） |
| 2 | [樓層清單每個事件重建一次](02-floor-list-rebuilt-on-every-session-event.md) | 是（09-03） |
| 3 | [投影每個事件都產生新 state，只為一個當下沒人讀的時間戳](03-projection-notifies-on-every-session-event.md) | 否，既有 |

第 1、2 項與 8/31 那批的第 2、4 項是同一個形狀 —— 為了很小的結果反覆處理很大的
輸入，以及該加快取的地方沒加。第 3 項則是**那批修補沒有碰到的根**：
8/31 給世界書視圖加快取，治的是這個根因的一個症狀。

---

## 修補一：摘要只讀有界的開頭

`FLOOR_PREVIEW_SCAN_LENGTH = FLOOR_PREVIEW_LENGTH * 8`，先截再折疊空白。
成本從「隨正文長度成長」變成常數。

保留一個 `truncated` 旗標：開頭 320 字若幾乎全是空白，折疊後可能不足 40 字，
但正文其實還有更多 —— 這時仍要帶省略號，否則摘要會謊稱自己是完整的。
順帶改成按碼位截斷，不會在代理對中間斷開。

## 修補二：樓層清單以表層引用做快取

```ts
if (floorCacheValue !== undefined && floorCacheSurface === state.surface && floorCacheHidden === hidden) {
  return floorCacheValue
}
```

**這是精確的，不是近似**：`applySurface()` 在事件不帶 `surfaceOp` 時
`return surface`（同一個陣列引用），而節點的正文在它的事件存在之後就不會再變
（替換落在新的 seq）。所以「表層引用不變 且 隱藏前綴引用不變」⇒ 清單必然相同。

## 修補三：只在狀態真的改變時才蓋 replay 時鐘

`apply()` 的主體抽成模組級的 `foldAgentRpProjectionEvent()`，直接吃 `state`；
外面包一層：

```ts
apply(state, event) {
  const next = foldAgentRpProjectionEvent(state, event)
  return next === state ? state : { ...next, replayTime: event.time }
}
```

`replayTime` 的用途只有一個：給 World Info 面板的 EJS 沙箱一個可重放的
`Date.now()`。它只有一個讀取點，而且 **`worldInfoCacheSignature` 刻意不含它** ——
也就是被驅動的那一刻根本沒人讀它。原本卻為了它，讓每個事件都宣告「我變了」，
於是框架驅動 `view()`、跑 schema 校驗、序列化整份 payload、送到瀏覽器。

---

## 實測

`view()` 本身（122 則訊息、約 295 KB，跑真實的 `wire.view`）：

| | 修補前 | 修補一＋二後 | |
| --- | --- | --- | --- |
| `view()` 一次 | 0.313 ms | 0.0061 ms | **51×** |
| × 6849 事件／輪 | 2.1 秒 | 0.042 秒 | |

修補前那 0.313 ms 裡約 **95%** 是 `floors`。

`view()` 被驅動的次數（6840 個事件的真實形狀事件流）：

| | 修補三前 | 修補三後 |
| --- | --- | --- |
| `apply()` 回傳新引用 | 6840 | **40** |

那 40 次正好是真正改變狀態的事件。所以 `view()`、schema 校驗、序列化、
wire 送出全部從每輪 6840 次降到 40 次 —— `floors`、`tavern.messages`、
世界書視圖、generations 一起解決。

## 為什麼沒有動 `tavern.messages`

它帶每則訊息的完整正文，看起來最肥，但那些正文是真的有人要：
`st-extension-host.ts` 用它餵 `SillyTavern.chat`，`tavern-runtime.ts` 的
`getChatMessages()` 讀它，`card-display.tsx` 與 `roleplay-display-plan.ts` 也讀它。
砍掉正文等於砍掉酒館相容層。

問題從來不是它多大，而是**它在沒變的時候還一直重送**。修補三把重送次數降了
99.4%，這一項就不必動了。

## 唯一的行為差異

EJS 的 `dateNow` 變成「最後一個**改變狀態**的事件時間」，而不是「最後一個事件時間」。

這不是新的不一致：世界書視圖本來就跨串流被快取，EJS 早就是拿快取未命中那一刻的
`replayTime` 在跑。修正後兩者反而對齊了 —— `view()` 執行時看到的一定是觸發這次
執行的那個事件的時間。

## 改動檔案

```
 src/projection.ts                 | 100 ++++++++++---   有界摘要、樓層快取、fold 拆分
 tests/projection-contract.test.ts |  62 ++++++++      兩條迴歸測試
```

測試涵蓋：

- 不論正文多長，摘要固定 40 碼位加省略號
- **不動表層的狀態變更不會重建樓層清單**（斷言回傳同一個陣列引用）
- 追加一層之後清單確實更新
- **與本單元無關的事件必須回傳同一個 state 引用**，且不推進 replay 時鐘
- 真正的狀態變更仍會把時鐘推進到該事件的時間

其中一條既有的樓層測試原本斷言「惰性事件會產生新 state」，那是照修補三之前的
行為寫的，這次一併倒過來 —— 它正好記錄了舊的假設。

## 驗證

```
focused          728 tests (712 passed, 16 skipped)
smoke             66 passed
session-launch    19 passed
http              11 passed
turn-recovery      9 passed
provider-seam     13 passed (12 passed, 1 skipped)
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1
```
