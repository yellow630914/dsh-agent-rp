# 本輪改動（2026-09-01）

兩個功能：**遷移聊天時帶上角色綁定的世界書**，以及**會話記憶的匯出／匯入**。
第三項需求（`/rp-compact`，可調壓縮比例）評估後**擱置**，原因見文末。

改動只在工作區，**尚未 commit、尚未部署**。四個效能 hotfix（[2026-08-31 世界書激活效能](../../bug/20260831_worldbook-activation-performance/CHANGE.md)）
仍是未提交狀態，本輪改動疊在它們上面。

---

## 一、遷移聊天帶上角色綁定的世界書

### 症狀

在「遷移聊天」面板選一張資源中心已有的角色卡，遷移完成後世界書面板是空的。

### 根因

`prepareAgentRpSession`（`src/session-launch.ts`）的 `character` 分支會呼叫
`appendCharacterWorldSessionSeed` 把角色綁定的世界書寫成 actor 快照；
`chat`（遷移）分支只做了 `seedWithPreset`，完全沒有這一步。而
`characters.resolve()` 回傳的 `worldBinding` 早就在手上，只是沒被使用。

實測兩條路徑的對照（同一張卡、同一份綁定）：

| 角色卡情況 | 遷移得到 | 「開始遊玩」得到 |
| --- | --- | --- |
| 有內建書 ＋ 使用者另外綁一本外部書 | 1 本（`character:library:card-…`） | 2 本（`character:library:world-info-…`） |
| 無內建書，只有使用者綁定的外部書 | **0 本** | 1 本 |

第二列就是回報的症狀。第一列之所以還有一本，是
`readSessionLorebookSourcesFromEvents`（`src/world-info-configuration.ts`）的舊版相容回退：
**沒有任何 actor 世界快照時**，才拿角色卡裡的 `character_book` 頂上。

所以修正前的實際狀態是：內建書靠回退僥倖生效、而且用的是卡裡的舊副本；
使用者在資源中心綁定的世界書則全部遺失。

### 改動

`src/session-launch.ts`，chat 分支：

```ts
seed: seedWithPreset(
  appendCharacterWorldSessionSeed(migrationSeed, character.worldBinding, worldInfos),
  presets,
  request.presetId,
),
```

`appendCharacterWorldSessionSeed` 與 `worldInfos` 本來就在這個函式的作用域裡
（character 分支在用），沒有新增 import 或依賴。

### 為什麼這樣就夠

加上 actor 快照之後，`hasActorWorldSnapshot` 成立，內建書的回退自動失效，
所以**不會出現同一本書重複兩遍**。投影那側（`src/projection.ts` 的
`provisionalLibraryCardLorebook`）也有對應處理，會把角色卡種子帶來的
`cardLorebook` 換成第一本 actor 世界。實測與重放都驗證過。

### 連帶影響

| 項目 | 判定 |
| --- | --- |
| 已有會話 | **無影響**。會話重放自己的事件日誌，不經過 `prepareAgentRpSession`。 |
| 世界書條目覆寫（`worldInfoConfiguration.overrides` 以 bookId 為鍵） | **無影響**。只有新建的遷移會話 id 形狀改變，舊會話的 id 不變，不需要資料遷移。 |
| `charLoreBook` / Tavern `getCharWorldbookNames` | **收斂**。取第一本 `source === 'character'` 的名字；拆分出的世界資源保留了 `character_book.name`，常見情況字串不變，只有使用者改過世界書名或換過主世界時才不同——而那正是應該跟隨的值。 |
| 沒有綁定（`worldBinding === undefined`，舊 Host 或未設定綁定庫） | **安全**。函式對 `undefined` 原樣返回，內建書回退繼續生效。 |
| 啟動權限預檢 | **無變化**。`tavern-resource-library-preflight.ts` 沒有任何 world 分支。 |
| 行為差異（需要認知） | 使用者把主世界綁定清成 `null` 的卡，修正後會正確地不帶書；修正前仍會硬塞卡裡的內建副本。 |

### 一個實測出來的成本

`appendCharacterWorldSessionSeed` 是**每本書 `structuredClone(整個 seed)` 再
`Session.create` 校驗一次**。character 路徑的 seed 只有 7 個事件無所謂，
遷移 seed 是上千個事件，成本量級不同。實測（538 KB／300 則訊息的 JSONL
→ 1502 個 seed 事件，4 本綁定世界）：

```
prepare（不含世界書） 58 ms   →   append 4 本世界書 72 ms
```

世界書追加比整個遷移準備還貴，且隨 `O(書數 × 事件數)` 線性增長；
綁滿 16 本約 290 ms。這是一次性的啟動開銷，可接受。
若之後嫌慢，解法是加一個「先全部追加、最後只 `Session.create` 一次」的批次版本。

### 尚未做的第二步

遷移面板目前沒有會話級世界書選擇器，`chat` 請求也在解析層就拒絕
`worldInfoIds` 這個欄位。要補的話會動到三處：`session-launch.ts` 的請求解析、
`LibrarySessionLaunchRequest` 協定、以及遷移對話框 UI。

**注意一個陷阱**：若照抄 character 分支寫成
`seedWithWorldInfos(seed, worldInfos, request.worldInfoIds, characterWorldIds)`，
當 `worldInfoIds` 是 `undefined` 時它會回退到 `worldInfos.defaultIds()`，
也就是資源中心裡標記為「新會話預設」的世界書會全部自動掛上。
這跟 character 路徑一致，但對遷移是不是想要的行為需要另外決定。

---

## 二、會話記憶的匯出／匯入

### 已定的決策

1. 匯入前先完整驗證，維持主題唯一性；有重複就**整批拒絕**
2. seq 一律以現行 session 為準，**忽略檔案裡的 seq**
3. 驗證通過才開始派發 seq 並寫入
4. 中途出錯能 rollback 就 rollback，不行則停止匯入
5. 加 `imported` 標籤；跨角色放行；一次上限 200 條

### 路線選擇

走「`/rp-memory` 新增 `operation: 'import'`」，而不是直接追加
`agent-rp/memory-seed` 事件。理由：

- `command/done` 是標準機制，**不需要打過補丁的 Host**
  （`appendAgentRpSessionEvent` 會在缺少 `appendIgnorable` 的 Host 上直接拒絕）
- 與所有其他 RP 變更走同一條路徑
- `applyCommandRecord` 已有 add/correct/forget 的重放校驗骨架，主題衝突檢查也已在其中

### 匯出

純前端，記憶管理對話框新增「導出」鈕。格式：

```json
{
  "format": 0,
  "kind": "agent-rp-memory-export",
  "exportedAt": "2026-09-01T00:00:00.000Z",
  "memories": [{ "kind": "fact", "subject": "…", "text": "…" }]
}
```

只有 `kind` / `subject` / `text` 跨越檔案邊界。**刻意不寫 `id` 和 `sourceEventSeq`**：
匯入時反正會忽略，寫進去只會讓下游工具誤以為它們有意義。
檔案不帶角色身分，跨角色匯入因此是天然放行的。

### 匯入：原子性

決策 4 擔心的 rollback 在這個設計下**不會發生**，時序是：

1. Host 先追加 `command/run`——**seq 在這一刻由 Host 分配**，處理器從
   `session.events.at(-1)` 取得
2. 處理器在**純記憶體裡**跑完整批驗證，任何一條不過就 `throw`
3. 驗證通過才回傳 `{ kind: 'success', text }`，Host 追加**一條** `command/done`
4. 記憶狀態完全由這條 `command/done` 在重放時產生

所以：不存在「派發 seq 中途失敗」（seq 不是自己派的，而且只 append 一次）；
不存在半截匯入（要麼這條記錄存在、N 條全生效，要麼不存在、零生效）；
驗證失敗時會話裡只留下一對 `command/run` + `command/done(error)`，記憶零變化。

> 對照：若走「連發 N 條 `/rp-memory add`」的路線，才會真的出現半截匯入，
> 而且 append-only log 無法回退。這是不採用它的主要理由。

### 匯入：id 與 seq

id 鑄成 `memory-seed-<sourceEventSeq>-<index>`，沿用既有 id 文法，
因此**沒有動 `MEMORY_ID_PATTERN`**。同一個 seq 不可能既是 `command/run`
又是 `agent-rp/memory-seed` 事件，所以與繼承記憶的 id 不會碰撞
（`applyCommandRecord` 另外還有 `active.has(id)` 的防線）。

檔案裡的 `id`、`sourceEventSeq`、`version` 一律不讀——解析時就不取這些欄位。

### 匯入：主題唯一性

用既有的 `memorySubjectKey`（`trim` + `toLocaleLowerCase`），**大小寫與前後空白折疊後**比較。查兩層：

- 檔案內部兩兩不重複——在 `memoryCommandRequest` 裡查，所以**重放時也會重查**
- 與當前會話的有效記憶不重複——在 `executeAgentRpMemoryCommand` 裡查，
  一次收集**全部**衝突主題再一起報錯，不是撞到第一個就停

### 匯入：寫入前自檢

`src/memory-command.ts` 的 `assertFoldsBack`：把還沒落盤的記錄組成一個臨時
`command/done` 事件，用真正的 `readAgentRpMemoryHistory` 折一遍，
並檢查有效記憶數量是否等於預期。

需要這一步的原因：`readAgentRpMemoryHistory` 對任何非法記錄**直接拋例外**，
而它在提示詞裝配（`src/prompt.ts`）、回合計劃（`src/roleplay-turn-plan.ts`）、
回合結算和 HTTP 路由上都被呼叫。**一條折不回來的記錄會讓該會話之後每一輪都失敗**，
而 append-only log 拿不回來。把讀取器本身當成驗證器，可以從根上消除這一類風險。

這個自檢對 add／correct／forget／import **四種操作都會跑**。代價是每次記憶操作
多一次全量重放；記憶操作很少而且都是使用者觸發的，可以接受。

### `imported` 標籤

`AgentRpMemoryRecord` 新增 `origin?: 'imported'`。必要的原因是**匯入和手動新增
都指向 `command/run`**，光看來源事件型別分不出來。`memory-http.ts` 先看
`origin` 再看事件型別，`AgentRpMemoryView.source` 多了 `'imported'`，
UI 顯示「從文件導入」。

匯入進來的記憶之後就是普通的有效記憶，可以纠正、可以忘記。

### 上限

一次 200 條。這個數字刻意遠低於 `agent-rp/memory-seed` 事件的 1000 上限，
因為：一次匯入是**一條**持久記錄，之後每次 `readAgentRpMemoryHistory` 都要重新
解析；而且每一條有效記憶都會進入系統提示。兩項成本都隨這個數字成長。

命令本身走 `/api/agent-rp/command` 的 4 MB 上限，200 條完全不是問題。

---

## 改動檔案

```
 src/session-launch.ts                 |  10 +-    需求一
 src/memory.ts                         |  98 +++-  import 操作、origin 欄位、批次重放
 src/memory-command.ts                 |  70 ++-   批次驗證、寫入前自檢
 src/memory-http.ts                    |  10 +-    imported 來源分類
 src/memory-protocol.ts                |   2 +-    source 聯集
 src/client/index.tsx                  |  69 +++-  匯出／匯入 UI、imported 標籤
 tests/character-world-binding.test.ts |  69 +++-  需求一測試
 tests/memory.test.ts                  |  95 +++-  匯入測試
 8 files changed, 404 insertions(+), 19 deletions(-)
```

## 驗證

```
focused          725 tests (709 passed, 16 skipped)
session-launch    19 passed
smoke             64 passed
http              11 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

需求一的測試斷言遷移與「開始遊玩」解析出**完全相同**的世界書清單，
且 id 是 `character:library:world-info-…` 而非舊的回退形狀，並驗證加了世界書
種子之後歷史仍可重放。需求二的測試涵蓋：整批原子寫入、匯入後仍可
纠正／忘記、與現有主題衝突時整批拒絕且會話狀態不變、檔案內部重複主題、
超過 200 條、條目帶多餘欄位、空陣列。

---

## 尚未處理

**未 commit、未部署。** 本機 commit 不需要遠端推送權限，
建議把四個 hotfix 和本輪改動 commit 起來，部署時才答得出「跑的是哪一版」。

**VM 上的 pnpm store 被寫穿。** 2026-08-31 那四個補丁是用 `fs.writeFileSync`
就地覆寫 `lib/index.js`，而 pnpm 是用 hardlink 從 content-addressable store 連進
`node_modules` 的：

```
inode 564994, links=3:
  /home/dsh/.dsh/profiles/web/node_modules/@hewzhew/dsh-agent-rp/lib/index.js
  /home/dsh/.local/share/pnpm/store/v11/files/6d/dbc166326b62fff1…   ← 檔名就是內容雜湊
  /home/dsh/.local/share/pnpm/store/v11/tmp/_tmp_UlZNxP/lib/index.js
```

store 裡那個以「原始內容雜湊」命名的檔案，內容已經是打過補丁的版本。
**「重裝一次回到乾淨狀態」在這台機器上是假的**——pnpm 會照樣把補丁過的內容
link 回來。要修就是刪掉那個 store 檔和殘留的 tmp 目錄，讓 pnpm 下次安裝重新抓；
刪除只會讓現行 `index.js` 的 link count 掉一，不影響正在跑的服務。

新的部署腳本（`D:\dsh-tavern-script\deploy-agent-rp.*`）換檔一律「先 `rm` 再 `cp`」，
不會再讓情況變糟，但既有的壞條目要另外清才會消失。

**需求三 `/rp-compact` 擱置。** 評估結論：Agent RP 的能力預設
（`preset/agent.cordis.yml`）根本沒有掛載 compaction，所以角色會話裡
`ctx.compaction` 是 undefined，`/compact` 也不存在。而且 seam 的手動入口
`compactNow` 寫死 `retainTokens = 0`（沒有比例參數），能吃比例的
`compactRegion` 在 basic 後端要求有開啟中的 turn，命令處理器跑在回合之間，
用不了。另外表層壓縮會動到多個以表層位置索引的子系統（酒館訊息 id、
MVU 折疊、回覆版本、世界書掃描窗口、JSONL 匯出）。要做的話需要先決定
要不要把 compaction 分組引入 RP 預設——那個決定比命令實作本身更重要。

---

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -DryRun
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -PruneBak
```

`-PruneBak` 會順手清掉 `lib/` 底下那四個 `.bak-pre*`——四個 hotfix 已經在 `src/`
裡，會隨這次建置一起上去，那些手動備份就過時了。
