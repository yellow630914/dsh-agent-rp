# 一次清空全部會話記憶（2026-09-07）

記憶管理新增「清空」，放在「導出」「導入」左邊：彈出確認窗，確認後**先導出、
再清空**當前全部有效記憶。

同一目錄下有對應的需求單。記憶匯出／匯入那一輪見
[20260901_migration-worlds-and-memory-io](../20260901_migration-worlds-and-memory-io/CHANGE.md)。

---

## 為什麼刪除時一定要導出

會話歷史只能追加，**刪除之後沒有撤銷**。那份導出檔是唯一的恢復途徑，而且它和
「導入」是同一個格式，可以直接放回來。

所以導出不是順手附加的貼心功能，是這個操作的安全網 —— 因此內建在流程裡，
而不是指望使用者記得先自己點一次「導出」。程式碼裡導出也**排在刪除之前**：
順序反了的話，一旦刪除成功而導出失敗，恢復途徑就沒了。

## Host

`/rp-memory` 新增 `operation: 'forget-all'`，與匯入同一個形狀：
**一條 `command/done` 記錄整件事**，而不是發 N 條 forget。

- 一次 `command/run` + 一次 `command/done`，要麼全清、要麼什麼都沒發生，
  沒有半清空的中間狀態要收拾
- 日誌裡只留一句「這裡清空過」，而不是一串逐條 forget 把真正的歷史淹掉
- 請求沒有任何欄位（只有 `format` 與 `operation`），多帶欄位會被拒絕
- 沿用寫入前自檢：和其他四種操作一樣，先用真正的 `readAgentRpMemoryHistory()`
  折一遍、確認有效記憶數量變成 0，才讓記錄落盤
- 沒有可清空的記憶時直接拒絕，避免留下一條什麼都沒做的記錄

`applyCommandRecord()` 的 `forget-all` 分支只做 `active.clear()` 並回傳空陣列 ——
**清空不建立任何記錄**，所以時間順序的 `history.all` 完全不受影響：
曾經記住過什麼、後來又清掉了，都還重放得出來。

## 界面

「清空」在「導出」左邊，危險色，沒有記憶時禁用。點擊彈出確認窗，寫明會刪除幾條、
會先導出、以及刪除之後沒有撤銷。

確認按鈕的文案是「**導出並清空**」而不是「確定」—— 按鈕本身就該說清楚它會做兩件事。

## 改動檔案

```
 src/memory.ts            |  22 ++++--   forget-all 請求、解析、比對、重放
 src/memory-command.ts    |  10 ++++    寫入前的空集合檢查
 src/client/index.tsx     |  47 ++++++   清空按鈕、確認窗、先導出再清空
 tests/memory.test.ts     |  38 ++++++   迴歸測試
```

測試斷言：一次 `command/run` + 一次 `command/done` 就清空整組；
`history.all` 保留全部曾經存在的記憶（清空不抹掉歷史）；提示詞不再帶任何記憶；
沒有可清空記憶時拒絕、且會話狀態不變；請求帶多餘欄位會被拒絕。

## 驗證

```
focused    731 tests (715 passed, 16 skipped)
smoke       66 passed
http        11 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1
```
