# 整本世界書的預設掃描深度：資源中心與會話設定分別可調（2026-09-11）

每本世界書 JSON 裡的 `scan_depth`（沒有自己填掃描深度的條目用的那個預設值）一直
被保留、也真的參與激活判斷，但**界面上看不見也改不了**。現在兩個地方都能看能改，
而且改的**不是同一個東西**。

同一目錄下有對應的需求單。資源中心的世界書編輯器那一輪見
[20260910_world-info-entry-editor](../20260910_world-info-entry-editor/CHANGE.md)。

---

## 兩層，不是兩個入口

| | 改的是 | 影響範圍 |
| --- | --- | --- |
| **資源中心** | **世界書本身**（鑄新 id，綁定跟著搬） | 以後所有新會話 |
| **會話設定** | **只有這次會話的覆蓋層** | 只有當前這一局 |

會話啟動時把世界書凍成了無損快照，之後再也不讀資源庫。所以「在資源中心改了、
正在玩的那局不會變」不是妥協，是這兩層各自該有的行為。

## 三種狀態，不是兩種

會話這一層有**三種**情況，少做一種就會出錯：

1. **沒有覆蓋** —— 跟著檔案走（檔案本身也可能沒寫）
2. **覆蓋成 N** —— 這次會話用 N
3. **覆蓋成「沒有」** —— 這次會話**主動取消**了檔案裡的預設深度

第 3 種和第 1 種結果完全不同：檔案寫著 `scan_depth: 3`，第 1 種掃 3 條，
第 3 種掃全部。所以**覆蓋記錄存在與否本身就是資訊**：

```ts
/** 記錄在、裡面沒有 scanDepth ⇒ 這次會話不設整本深度 */
interface WorldInfoBookOverride { bookId: string; scanDepth?: number }
```

對應兩個請求：`set-book-scan-depth`（省略 `scanDepth` 就是第 3 種）與
`reset-book-scan-depth`（回到第 1 種）。`reset-book`／`reset-all` 一併清掉整本設定 ——
「恢復原檔案」本來就該包含它。

`configuredLorebook()` 套用時是把檔案的 key **整個拿掉再決定**，而不是往上疊 ——
疊的話第 3 種就表達不出來。

## 投影

`books[].scanDepth` 從「檔案的值」改成**這次會話實際生效的值**，另外補兩個欄位：
`fileScanDepth`（檔案原值，讓界面說得出「恢復」會恢復成什麼）與 `scanDepthModified`
（這次會話有沒有自己決定過）。

## 存回檔案時不能弄丟位置

`worldInfoWithEntries()` 的 `scanDepth` 改成**必填參數**（`number | undefined`），
呼叫端沒辦法含糊地「不傳表示保持」。移除時是先 clone 再 `delete scan_depth`，
保留時則靠覆寫同名 key —— JS 覆寫既有 key 不會改變它的位置，所以**沒改深度的書
存回去仍然是位元組相同的**，不會白白鑄一個新 id。測試直接斷言 key 順序。

## 提交時機

輸入框**不是邊打字邊提交**。會話覆蓋層是只能追加的命令日誌，每個按鍵提交一次的話，
打「100」會寫三條命令，而且後兩條會撞上自己的 revision 檢查直接報
「世界书已在别处改变」。

沿用手動上限那一欄的做法：本地草稿 + 一個「應用」按鈕，值沒變時按鈕停用，
提交成功後清掉草稿讓它回去跟投影同步。

## 順手修掉的一個型別破綻

`resource-center.tsx` 原本把 `loadWorldInfoEntries` / `saveWorldInfoEntries` 的形狀
**重抄了一遍**，而不是用編輯器匯出的型別。這正是之前 `prepareChatMigration` 掉參數
那個 bug 的同一類 —— 函式型別對參數個數是相容的，少一個參數編譯器不會吭聲。
改成直接引用 `LoadWorldInfoEntries` / `SaveWorldInfoEntries`。

## 改動檔案

```
 src/world-info-configuration-types.ts  |  17 ++   WorldInfoBookOverride、兩個請求
 src/world-info-configuration-core.ts   |  91 ++   解析、套用、重設、上限校驗
 src/projection-types.ts                |   5 ++   生效值 / 檔案值 / 是否被改過
 src/projection.ts                      |   5 +-   改讀 configured
 src/embedded-world-info.ts             |  13 +-   scanDepth 改必填參數
 src/world-info-library-protocol.ts     |   8 ++   詳情與編輯協定
 src/world-info-library-http.ts         |   9 +-   GET 回傳、PUT 接受
 src/client/world-info-editor.tsx       |  28 ++   資源中心的整本欄位
 src/client/resource-center.tsx         |  17 +-   改用共用型別
 src/client/index.tsx                   |  70 ++   會話設定的整本欄位與草稿
 tests/world-info-configuration.test.ts |  103 ++  會話覆蓋層
 tests/world-info-library-editor-http.test.ts | 72 ++  資源中心
```

## 測試

**會話覆蓋層**（4 條）—— 檔案深度 3 時最舊那則訊息**真的被掃到**、覆蓋成 1 之後
**真的掃不到**（走 `inspectLorebook`，不是只比對欄位）；第 3 種狀態存得下也讀得回；
`reset-book-scan-depth` 清掉整本設定但**留著條目覆蓋**；`reset-book`／`reset-all`
兩者都清；越界值（負數、小數、超過 10000、字串）一律拒絕；舊快照沒有 `bookOverrides`
仍然讀得起來。

**資源中心**（2 條）—— GET 回傳整本深度；存成 1 之後 `token_budget` 等其他整本設定
原樣還在；省略 `scanDepth` 會讓 `scan_depth` **真的從檔案裡消失**（不是寫成 null）；
壞值 400；`scan_depth` 存回去**還在原位**、第二次相同存檔是 no-op。

```
focused         743 tests (727 passed, 16 skipped)
smoke            66 passed
http             11 passed
session-launch   20 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 尚未驗證

兩個輸入框**沒有實機點過**，只過了型別檢查與 Host 端測試。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
