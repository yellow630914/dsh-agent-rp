# 會話級正則與歸檔會話工具（2026-09-14）

兩個功能一起收尾：**每段會話有自己的一份正則且可編輯**，以及**歸檔會話的查詢、
還原與刪除**。同一目錄下有兩張需求單。分層背景見
[docs/transcript-layers.md](../../docs/transcript-layers.md)。

---

## 一、會話級正則

### 調查先行：缺的不是欄位，是入口

`ImportedRegexScript` 本來就是完整的 SillyTavern 形狀 —— `placement`（掃描對象）、
`markdownOnly` / `promptOnly`（作用階段）、`minDepth` / `maxDepth`（**掃描深度**）、
`trimStrings`、`substituteRegex`、`runOnEdit` 全都在。角色卡、預設、正則包也**本來
就已經是會話快照**。

唯一真正的破口是：**純顯示正則讀的是角色庫的即時版本**。在角色庫改一條顯示正則，
所有已經開始的會話畫面都會跟著變 —— 提示詞正則是凍結的，顯示正則不是。沒人發現過。

### 覆蓋層：用 `(owner, index)` 定址

`owner` 直接沿用既有的三個執行順序分組：`regex`（正則包）／`prompt-policy`（預設）／
`actor`（角色卡）。**提示詞側與顯示側用的是同一組分組、同一個順序**，所以一次編輯
兩端都到，不需要兩套對照。

幾個刻意的決定：

- **表達式原樣保存，不在寫入時拒絕** —— 寫壞的規則就是永遠不命中的規則（既有摘要
  已經會報），在這裡擋掉只會讓人存不了打到一半的樣式
- **刪除是保留定址的軟刪除**，同時強制 `disabled`，讓只讀規則本身的消費端也會跳過
- **切回匯入值時覆蓋層整個消失** —— 「放回去的」和「沒動過的」無法區分
- 會話自建規則排在所有匯入集合之後

顯示側套用時**把 `frontend.regexScripts` 清空**，否則角色卡規則會被跑兩次（它已經在
覆蓋層清單裡了）。同時三個 `withCurrentCharacterDisplayScripts()` 呼叫點全部改成讀
**這段會話的 `actor` 分組** —— live 破口就此關閉。

### 分支不用寫程式碼

覆蓋層是 durable session record。實測 VM 上 20 個有 `parentSession` 的 session，
`agent-rp/*-seed` **全部都會被帶進子 session**，同一個機制自動生效。

### 界面

會話設定新增「正則」面板：左側按來源分組列出（含「已改」「已停用」「已刪除」標記），
右側編輯名稱、查找、替換、剔除字串，以及三組開關 —— **掃描對象**（玩家／角色訊息）、
**作用階段**（僅顯示／僅生成／兩者）、**掃描深度**（最淺／最深，留空為不限）。
另有停用、刪除／恢復、恢復匯入值、新增本會話規則、全部恢復。

面板文案直說「改動只屬於這段會話，不會影響角色庫、預設或正則包，分支時會一起帶走」。

### 效能：三層浪費

串流時每個 chunk 都會讓 `MutationObserver` 觸發一次 rAF 掃描，而掃描會走過畫面上
**每一列**重跑一次顯示正則。三處都修了（已在 `2b011ff` 先行落地）：

| 問題 | 修法 |
| --- | --- |
| `compileRegex()` 沒有快取 | 以來源字串為 key 快取，上限 512 條 |
| 顯示計畫每次掃描重建 | 每列記憶一次；一列的計畫只取決於它自己的身分與文字 |
| `withCurrentCharacterDisplayScripts()` 每次回傳新物件 | 輸入相同時回傳同一個參照 |
| 計畫器每幀重建 | 輸入完全相同時沿用，讓上面那層記憶跨幀存活 |

**投影只在 surface 事件落盤時才變，不會每個 chunk 變**，所以串流整段都能命中快取 ——
只有正在寫的那一列需要重算。提示詞側本來就沒問題（`llm/stream` 每請求一次）。

## 二、歸檔會話

### DSH 只開放了一半

| | 有嗎 |
| --- | --- |
| `workspaceRegistry.archivedSessionIds`（讀） | ✔ |
| `archiveSession(id)`（加入） | ✔ |
| **unarchive** | ✘ |
| **delete session** | ✘（`sessionPersistence` 也沒有） |

歸檔集合存在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`，
而 registry **在記憶體裡 cache 了這份狀態** —— 熱改檔案會被它自己的下一次寫入整份蓋掉。

### 所以分成兩半

**看見**（熱的，插件裡）：`GET /api/agent-rp/archived-sessions` 讀
`workspaceRegistry` 配 `sessionPersistence.list()` 拿標題、時間、事件數與大小，
資源中心新增「歸檔會話」分頁。兩個服務都用 `ctx.get()` 取得而不是 `inject` ——
沒掛這些服務的 Host 仍然載得起來，面板會說「這個 Host 沒有歸檔概念」而不是顯示空清單。
**完全唯讀，不碰 Host。**

**還原與刪除**（冷的，部署腳本）：在**服務停止的視窗內**完成，改完啟動並跑健康檢查。
沒有第二個寫者可以競爭，也沒有記憶體狀態會蓋掉我們。

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action sessions
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action sessions-restore -SessionId session-xxx
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action sessions-delete  -SessionId session-xxx
```

刪除會**先把整份日誌完整備份到 `/var/backups/dsh`** 再移除，並順手清掉投影快取與
歸檔集合裡那個指不到東西的 id。`workspace.json` 每次改動前也會另存一份。

實測：`-Action sessions` 列出 22 個歸檔會話（含標題與大小），
`-Action sessions-restore` 對其中一個執行後，它確實從清單上消失，服務健康。

## 改動檔案

```
 src/regex-configuration-types.ts     新檔：可編輯欄位子集、覆蓋層、請求
 src/regex-configuration-core.ts      新檔：折疊、套用、狀態轉移
 src/regex-configuration.ts           新檔：從 durable log 重建來源、執行 /rp-regex
 src/client/regex-manager.tsx         新檔：正則管理面板
 src/archived-session-protocol.ts     新檔：歸檔列表協定
 src/archived-session-http.ts         新檔：唯讀歸檔列表
 src/client/archived-session-client.ts 新檔：瀏覽器端讀取
 src/roleplay-turn-plan.ts            提示詞側套用覆蓋層
 src/session-roleplay-runtime.ts      解析覆蓋層
 src/roleplay-display-plan.ts         顯示側套用；每列記憶
 src/frontend-regex.ts                編譯快取；穩定合併參照
 src/projection.ts / -types.ts        折疊覆蓋層並導出 regex.scripts
 src/client/index.tsx                 面板掛載、命令串接、關閉 live 破口、計畫器快取
 src/client/resource-center.tsx       歸檔會話分頁
 D:\dsh-tavern-script\*               sessions / sessions-restore / sessions-delete
```

## 測試

**regex-configuration**（7 條新增）—— 定址順序、編輯不動匯入集合、切回原值不留痕、
軟刪除保留定址但不執行、自建規則排序與編輯、壞值與過期 revision 被拒、快照重放
（含「沒開過管理面板的會話讀成空覆蓋層」）。

**roleplay-display-plan**（1 條新增）—— 同一列回傳**同一個計畫物件**、串流中長出來的
chunk 會重算、沒在串流的那一列跨幀保持快取。

```
focused         754 tests (738 passed, 16 skipped)
smoke            67 passed
http             11 passed
session-launch   20 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 尚未驗證

**正則面板與歸檔分頁沒有實機點過** —— Host 端邏輯全測過，兩個界面只過了型別檢查。
建議上線後：開一段會話進「設定 → 正則」，停用一條角色卡規則，確認畫面立刻變化；
再開資源中心的「歸檔會話」分頁確認列得出來。

`sessions-restore` / `sessions-delete` **已在 VM 上實測過**（restore）。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
