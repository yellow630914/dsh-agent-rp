# 部署中的手動修補（2026-08-31）

這台 `dsh-web` 實例**暫時停留在目前版本**，不跑更新腳本。原因是本文記錄的四個效能修補直接改在部署的 bundle 上，
任何 `pnpm install`／更新腳本都會把它們覆蓋掉。

- 主機：GCP `dsh-web`（asia-east1-b，**e2-small**：2 顆共享 vCPU、持續基準 0.5 vCPU）
- 服務：`dsh-web.service`，profile `web`，執行 `~/.dsh/runners/agent-rp/node_modules/.bin/dsh`
- 釘住的版本：`github:hewzhew/dsh-agent-rp#f8b98d9eb4bbffa218db3a755da7a61b0c731b7c`
- 被修補的檔案：`/home/dsh/.dsh/profiles/web/node_modules/@hewzhew/dsh-agent-rp/lib/index.js`

同樣的修改已經套用到本專案的 `src/`，可以用 `git diff` 檢視；同一個目錄下有對應的四份問題單。

---

## 問題背景

角色扮演 session 掛上 `西幻_Worldbooks`（2 本書、59 條、其中 41 條 `useRegex`、376 個 key）之後，
出字速度崩潰到一輪要一個半小時，嚴重時整個服務失去回應——連 `session.list` 都會逾時。

根因是一條路徑上疊了四個獨立問題。**四者相乘**才造成觀察到的症狀：

| 層 | 問題 | 單次啟用判定的成本 |
| --- | --- | --- |
| 1 | 純文字 key 也被送進 QuickJS WASM | ~5000 ms（含 2、3） |
| 2 | 每個 key 都把整段對話重新小寫化 | ↑ 同上 |
| 3 | 每個條目各自重建一份掃描文字 | 100.7 ms |
| 4 | 每個 session 事件都重算一次（串流時＝每段輸出） | ×6849 次／輪 |

關鍵事實：**這條路徑只餵 UI 的世界書面板**。送給模型的提示詞走 `prepareRoleplayTurn`
（`src/roleplay-turn-plan.ts`）自己的解析，與此無關——所以第 4 個修補不會改變模型收到的內容。

---

## 四個修補

### 1. 純文字 key 走原生比對，不進 QuickJS

`regexMatches()` 只在「沒有 runtime」時才使用原生的 `literalRegexMatches()`；只要 QuickJS 起得來，
連「這段文字裡有沒有『莱茵』」都要複製整段對話進 WASM heap 再跑一次正則。

改成**先試原生路徑**，失敗（表示 key 真的含正則語法）才交給 QuickJS。這正是 `409ba7f`（2026-08-15）
之前的行為。

- 檔案：`src/import/lorebook.ts` → `regexMatches()`
- 備份：`lib/index.js.bak-preliteral`
- 等價性實測：353 個 key ／ 223 KB 對話，原生命中 69、正則命中 69，**0 筆不一致**
- 這批資料的 24 條會掃描的條目**全部**改走原生（0 條仍需 QuickJS）

  兩個可觀察的行為差異（都認為是修正，但仍是差異）：

  1. **資源上限不再套用於純文字 key**。QuickJS 路徑有 `MAX_REGEX_INPUT_CHARS = 512 KB`、
     `MAX_REGEX_EVALUATIONS = 4096`、`MAX_REGEX_PATTERN_CHARS_PER_MATCHER = 2 MB`。
     掃描文字超過 512 KB 時舊路徑回 `resource-limit`（條目**不啟用**），新路徑會正常比對並**啟用**。
     對話夠長時看得到差別。
  2. **大小寫折疊語意**。原生用 `toLocaleLowerCase()`，正則用 `i` 旗標的 Unicode case folding。
     絕大多數字元相同，特殊情形不同（土耳其語 i/İ、德語 ß vs SS、希臘文末位 sigma）。中文 key 不受影響。

  另外，純文字條目不再可能出現 `regex-invalid` / `execution-limit` / `resource-limit`，
  面板上的「未啟用原因」會從錯誤變成正常的 `primary-unmatched`。

### 2. 掃描文字只小寫化一次

`includesKey()` 每次呼叫都做 `text.toLocaleLowerCase()`——353 個 key 就是 353 次對整段 223 KB 對話的
locale 感知小寫化。

改成單槽快取，同一份文字只算一次。

- 檔案：`src/import/lorebook.ts` → 新增 `lowerCased()`，`includesKey()` 改用它
- 備份：`lib/index.js.bak-prelower`
- 實測：一次啟用判定 **5018 ms → 227 ms**（單次冷量測）；重複三次取平均的穩定值約 **22 ms**

### 3. 掃描文字只建構一次

掃描文字是在 `candidate()` 裡逐條目建構的：`messages.slice(-depth).join('\n')`。
沒有條目覆寫深度時，24 個條目就重建 24 份一模一樣的 206 KB 字串。

改成以 `(messages, depth)` 為鍵的單槽快取。

- 檔案：`src/import/lorebook.ts` → 新增 `scanText()`，`candidate()` 改用它
- 備份：`lib/index.js.bak-prescantext`
- 實測：**100.7 ms → 0.50 ms**（24 條目、122 則訊息、206 KB）
- 這一項比 key 比對本身更貴，也讓「調 `scanDepth`」變得不再必要

### 4. 面板投影只在輪次邊界重算

`worldInfoProjection()` 位於 client-visible 的 `view` 裡，Host 會在**每個事件 append 之後**驅動它，
串流時模型吐的每一段都是一個事件。

改成以「不含進行中回覆內容」的簽章為鍵做快取：設定 revision、世界書 id 清單、角色名、
`surface` 則數、`currentReplySeq`。這些值在串流期間不變，只在**送出訊息**與**回覆結束**時改變。

- 檔案：`src/projection.ts` → 新增 `worldInfoCacheSignature()` 與快取包裝，原函式改名 `worldInfoProjectionUncached()`
- 備份：`lib/index.js.bak-prewicache`
- 效果：以實測的一輪 6849 個事件估算，啟用判定從 **6849 次 → 約 2 次**
- 可見代價：世界書面板在串流期間不即時更新，回覆結束後才刷新
- **前提**：串流中 `surface` 則數不變（回覆是同一個節點的文字在長大）。若實際不是如此，快取不會命中——
  不會出錯，但也不會有效果

---

## 還原與驗證

完整還原成未修補狀態：

```bash
sudo cp /home/dsh/.dsh/profiles/web/node_modules/@hewzhew/dsh-agent-rp/lib/index.js.bak-preliteral \
        /home/dsh/.dsh/profiles/web/node_modules/@hewzhew/dsh-agent-rp/lib/index.js
sudo systemctl restart dsh-web
```

確認四個修補都在：

```bash
for k in literalMatchedKeys lowerCacheSource scanTextCached worldInfoCacheKey; do
  echo "$k: $(sudo grep -c $k /home/dsh/.dsh/profiles/web/node_modules/@hewzhew/dsh-agent-rp/lib/index.js)"
done
sudo node --check /home/dsh/.dsh/profiles/web/node_modules/@hewzhew/dsh-agent-rp/lib/index.js
```

修補後的健康基準（冷讀取，投影快取已清空）：

```
session.history   0.07 – 0.45 s
閒置 CPU          0%
```

---

## 沒有處理的部分

- **e2-small 的容量**：持續基準只有 0.5 vCPU，任何長期吃滿一顆核心的行為都會拖垮整台機器
  （SSH、隧道、UI 一起變慢）。修補後閒置為 0%，但這個上限仍在。
- **`useRegex` 無法在 UI 關閉**：`editableWorldInfoEntry()` 沒有把它列為可編輯欄位，
  `applyEditable()` 明確保留原值。這 41 條的旗標來自世界書 JSON 的 `use_regex`，要改只能改來源檔重新匯入。
- **沒有刪除 session 的 API**：`session.*` 只有歸檔，磁碟目錄與投影快取紀錄會永久累積。
- **投影快取無上限成長**：`session_projcache.json` 是單一 JSON 檔，整包讀入、整包寫回；
  `agentRp` 一格內嵌角色卡原文、世界書條目全文與對話訊息，單一 session 可達 400 KB。
