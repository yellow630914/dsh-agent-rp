# 資源中心直接編輯世界書條目（2026-09-10）

資源中心每一本世界書多了「編輯」：直接改條目、新增條目、刪除條目，
存檔之後**綁定它的角色卡自動跟上**。

同一目錄下有對應的需求單。會話設定裡那個只作用於當前會話的世界書編輯器不受影響。

---

## 角色卡綁的是引用，不是複本

導入角色卡時卡內的 `character_book` 會被拆成一本獨立世界書資源，角色卡用 **id 引用**它。
新會話從 `worldInfos.asset(id)` 讀當前內容，匯出角色卡時 `exportModified` 用綁定的
世界書**重建** `character_book`。

**只有一份**，所以不存在「兩邊都要改」。要保證的是另一件事：**編輯之後綁定不能斷**。

## 編輯 = 換身分

世界書 id 是**內容的 sha256** —— 這正是重複導入同一個檔案會自動去重的原因。
所以編輯**不可能保留原 id**：真保留了，日後有人導入**原始那個檔案**，
雜湊算出來是這個 id、發現檔案已經在，就會拿到**編輯後**的內容。

`WorldInfoLibrary.update()` 是一次交易：

**寫新世界書 → 改寫全部角色綁定 → 搬移 `.default` 標記 → 退休舊的**

順序是為了崩潰安全：中途斷在任何一步，最壞只是留下一個沒人引用的世界書檔，
**絕不會出現指向不存在世界書的綁定**。

`CharacterWorldBindingStore.replaceWorldInfoId()` 負責改寫綁定，provenance 原樣保留 ——
`embedded-import` 編輯後仍然是 `embedded-import`，變的是文字，不是這本書**從哪來**。

擋掉一個邊界情況：編輯後的內容**剛好等於另一本已被角色綁定的世界書**時直接拒絕。
否則內容位址一致就會靜默合併兩本書，把別人的綁定一起吃掉。

## 存回去不能弄丟東西

社群世界書常常帶著這個 runtime 沒有建模的欄位（`probability`、`extensions` 裡的
自訂開關……）。存回去時若按 runtime 的模型重新序列化，這些欄位就**被靜默丟掉了** ——
這是最容易把別人的世界書寫壞的地方。

所以**格式知識全留在 Host 端**：瀏覽器只送結構化條目，每一列帶一個 `sourceIndex`
說明**它來自哪個原始條目**，Host 用既有的 `projectedEntry` 把那個原始 JSON 物件帶過去。
沒有 `sourceIndex` 的列就是新增，省略掉某一列就是刪除。

新增條目的 uid 接著這本書自己的編號往下排，而不是漏出 runtime 內部的列名 ——
編輯過的世界書導出去，讀起來還是一本普通的 SillyTavern 世界書。

## 協定

`/api/agent-rp/world-info` 多了兩件事，其餘不動：

- `GET ?id=<世界書 id>` —— 回傳這本書的可編輯條目（沒有 `id` 時仍然是列表）
- `PUT` —— `{ format, id, entries: [{ sourceIndex?, entry }] }`，**整本取代**

送整本而不是逐條操作，是因為每次存檔都會鑄一個新 id：把一次編輯合成一次存檔，
身分只跳一次。條目數上限 4096，與導入端同一個天花板。

## 界面

「編輯」在每一列世界書上。對話框左邊條目清單、右邊表單，沿用會話設定那一版的
`WorldInfoEditableEntry` 與同樣的欄位結構：標題、備註、主／次要關鍵詞、正文、
啟用、常駐、插入順序。新增的列標「· 新增」，「保存」在沒有改動前是停用的。

和會話設定那個編輯器的**作用對象不同**：

| | 會話設定 | 資源中心（本次） |
| --- | --- | --- |
| 改的是 | 不可變導入書上的**覆蓋層** | **來源本身** |
| 刪除 | 可還原的開關 | **真刪** |
| 新增條目 | 沒有 | 有 |

## 已經開始的會話不受影響

會話啟動時把世界書**無損快照**寫進了自己的事件日誌，之後再也不讀資源庫。
這是刻意的：正在玩的那局不會因為你在資源中心改了一句話而中途變樣。
想讓改動生效，開新會話。

## 改動檔案

```
 src/world-info-library.ts              |  58 ++   update() 交易
 src/character-world-binding-store.ts   |  42 ++   replaceWorldInfoId()
 src/embedded-world-info.ts             |  60 ++   worldInfoWithEntries / blankLorebookEntry
 src/world-info-library-http.ts         |  69 ++   GET ?id= 與 PUT
 src/world-info-library-protocol.ts     |  32 ++   編輯與詳情協定
 src/world-info-configuration-core.ts   |   6 +-   匯出 applyEditable / editable
 src/client/world-info-editor.tsx       | 268 ++   編輯對話框（新檔）
 src/client/resource-center.tsx         |  26 ++   「編輯」按鈕、採納新 id
 src/client/index.tsx                   |  42 ++   load/save 呼叫與 prop 串接
 tests/character-world-binding.test.ts  |  38 ++   綁定跟著換身分
 tests/world-info-library-editor-http.test.ts | 新檔：GET ?id= / PUT
```

## 測試

`tests/character-world-binding.test.ts` —— 編輯後 id 改變、綁定跟著走且 provenance 不變、
`.default` 標記跟著走、舊世界書已退休、**角色卡匯出帶新內容**、存回相同內容不做無謂的 id churn。

`tests/world-info-library-editor-http.test.ts`（新）—— `GET ?id=` 回傳可編輯條目、
一次存檔同時改寫／新增／刪除、**沒建模的欄位 `probability` 與 `extensions` 原樣留下**、
保留的條目沿用自己的 uid 而新增的接著往下排、壞請求（越界 `sourceIndex`、
型別錯的 `insertionOrder`、錯的 `format`）一律 400 且**不寫任何東西**、
`allow` 標頭列出 `PUT`。

```
focused         737 tests (721 passed, 16 skipped)
smoke            66 passed
http             11 passed
session-launch   20 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 尚未驗證

編輯對話框**沒有實機點過** —— Host 端交易與 HTTP 兩端都有測試，UI 只過了型別檢查。
上線後建議先拿一本不重要的世界書走一次新增／編輯／刪除。

表單目前露出標題、備註、主次關鍵詞、正文、啟用、常駐、插入順序；其餘欄位
（位置、掃描深度、注入深度／角色、優先度等）**原樣保留**但這個界面改不到。
要補的話是同一個表單加欄位，不動底層。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
