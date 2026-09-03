# 本輪改動（2026-09-03）

兩個功能：**修改輸入後就地重新生成**，以及**會話設置裡的樓層可見度面板**。

同一目錄下有對應的兩份需求單。前一輪（遷移世界書、記憶匯出入）見
[20260901_migration-worlds-and-memory-io](../20260901_migration-worlds-and-memory-io/CHANGE.md)。

---

## 一、修改輸入 → 就地重新生成

### 動機

回合尾的「修改輸入」原本只有一種結果：`prepareAgentRpRewriteSession()` 建立一段
標題帶「· 改寫」的**新會話**，原會話一個位元都不動。那是「從這一輪之前分岔」，
不是「修改」。玩家要的常常是就地換掉那句話、讓角色重答一次，而且**不要留著
那條回答舊問題的回覆**。

### 改動

`src/generation.ts` 新增 `rewrite-input` 操作，走既有的 `/rp-generation` 命令：

1. 驗證該回覆是**表層最後一個節點**，否則丟 `只能修改对话末尾这一轮的输入`
2. 從回覆往前找到本輪的使用者訊息，把 **[使用者訊息 … 表層末尾]** 整段用一條新的
   `user/message` 取代 —— 舊回覆連同本輪放到表層的 notice、工具結果一起被遮蔽
3. 還原本輪開始時的 MVU / Tavern 基準（與 `regenerate` 用同一組
   `mvuBeforeReply()` / `readTavernHelperStateSnapshot()`）
4. 用一條專屬指令生成：「玩家修改了訊息，當成第一次回覆它，不要提及修改、
   不要延續任何更早的回覆」
5. 失敗時把原使用者訊息與原回覆都放回表層，還原狀態後拋出

### 兩個刻意的設計決定

**不寫 `agent-rp/generation-state`，所以不產生版本群組。** 版本群組裝的是
「同一條訊息的不同答案」；輸入改了之後，舊回覆回答的是一條已經不存在的訊息，
放進版本清單只會讓「切回上一版」產生語義錯位。

**「刪除」是表層遮蔽，不是抹掉日誌。** Session log 只追加，原始事件仍在檔案裡
（`session-repair` 還救得回來），只是模型和界面都看不到。這是 append-only
架構下唯一能做的刪除。

### 界面

更多操作選單變成兩項：

| 選單項 | 可用條件 |
| --- | --- |
| 修改输入并重新生成 | 最後一輪、且 regenerate 可用（含 Host 插件事件能力檢查） |
| 修改输入并另开分支 | 任何已完成回合（原行為不變） |

同一個編輯框依模式切換說明與按鈕文案。就地重生那個模式明確寫出：舊回覆不保留為
可切換版本、本輪已沉澱的狀態與插圖不會跟著回退——這一項確認過不要求回退，
但不能讓它變成沉默的意外。

### 為什麼只給最後一輪

`latestReply()` 明確拒絕非末尾回覆（`只能操作对话末尾的角色回复`），
而「修改輸入」原本任何回合都能點，因為分岔不需要末尾。兩個動作放在同一個選單裡，
所以「哪個能用」必須一眼可見，而不是點下去才報錯。

另外 `generate()` 開頭檢查 `agent.status !== 'idle' || agent.inbox.hasPending`
（`AgentStatus` 只有 `'idle' | 'running'`），所以出字期間兩個動作都不可用。

---

## 二、樓層可見度面板

### 動機

對話一長，玩家沒有任何界面途徑知道「這一輪到底把哪些樓層送進了模型」，
也沒法主動把前面不再需要的樓層移出上下文。`/hide` 已經存在，但只有酒館腳本
或卡片前端觸發得到，玩家自己碰不到、也看不到結果。

### 沿用既有的前綴隱藏

`setHidden()` 有兩道寫死的限制——只能從第 0 樓開始隱藏、只能一次全部恢復；
資料結構本身就叫 `hiddenPrefix`，是前綴陣列而不是每則訊息的旗標。
這次**接受這個形狀**，Host 端一行沒改，只接界面。

隱藏的作法是把訊息**從 DSH 表層移除**（`rewriteSurface`），文字留在 `hiddenPrefix`
供腳本讀取。所以「隱藏」= 真的不進模型上下文。

### 投影新增 `floors`

`src/projection.ts` / `src/projection-types.ts` 新增一份輕量樓層清單：
每層帶 `seq / role / preview（40 字）/ hidden`，隱藏的排前面。

兩個刻意的性質：

- **不依賴酒館狀態。** 由 `state.surface` 與 `tavern?.hiddenPrefix` 組合而成，
  所以沒碰過腳本的原生會話一樣有樓層清單。既有的 `tavern.messages`
  只在 `state.tavern !== undefined` 時存在。
- **只帶摘要。** 這份清單每次投影更新都會送到瀏覽器，所以不重複
  `tavern.messages` 那份完整正文。

### 界面與提交

會話設置 →「樓層」。滑桿設定要隱藏最前面幾層，上限是「總層數 − 1」
（至少留一層讓角色能接話）；下方列出全部樓層，被劃掉的就是這次會隱藏的。

**拖動不提交，按「確定」才生效。** 理由在下一節。

提交邏輯沿用既有的 `set-chat-hidden`：

- 目標 < 目前：先 `hidden:false` 整段恢復，再 `hidden:true` 隱藏目標層數
- 目標 > 目前：直接 `hidden:true`
- 相等：不發請求

### 已知代價（都在確認過的接受範圍內）

**恢復是有損的。** `setHidden()` 恢復時把隱藏訊息重建成 `kind: 'synthetic'` 的
新事件，原 assistant 事件身分沒了。

**連沒被隱藏的樓層也會拿到新 seq。** `rewriteSurface()` 第一個節點用
`replace(整段)`、其餘全部 `append`，所以每次隱藏或恢復都重新追加整個表層。
掛在舊 seq 上的回覆版本、訊息註記、該樓層的生圖關聯都會對不回去。

**每次調整的事件成本 ≈ 剩餘可見樓層數。** 以 300 則訊息的會話估：

| 操作 | 追加的事件數 |
| --- | --- |
| 隱藏前 20 層 | ≈ 280 |
| 全部恢復 | ≈ 300 |
| 再隱藏前 10 層 | ≈ 290 |
| 20 → 10 合計 | ≈ 590 |

這就是「按確定才提交」的直接原因：滑桿若邊拖邊送，拖過二十格就是十幾次
全表層重寫。這個理由也寫進了 `manageFloors()` 的註解裡。

---

## 改動檔案

```
 src/generation.ts        | 125 ++++++++++---   rewrite-input 操作與失敗還原
 src/client/index.tsx     | 201 +++++++++++---  兩項選單、編輯框模式、樓層面板
 src/projection.ts        |  27 ++++          floors 清單與 schema 校驗
 src/projection-types.ts  |  14 ++++          floors 型別
 tests/generation.test.ts | 101 ++++++++++    rewrite-input 測試
 5 files changed, 438 insertions(+), 30 deletions(-)
```

加上重新建置的 `lib/`（`lib/index.js`、`lib/client.js`、`lib/client.js.map`）。

> `lib/` 是被追蹤的，而且 `package.json` 只有 `prepack`、沒有 `prepare`，
> 所以 `github:` 安裝路徑拿到的就是 commit 裡的建置產物，不會在安裝時重建。
> **`lib/` 一定要跟 `src/` 在同一個 commit**，否則從那個 commit 重裝會拿到舊程式碼
> 而且沒有任何錯誤訊息。

## 驗證

```
focused          728 tests (712 passed, 16 skipped)
smoke             64 passed
session-launch    19 passed
http              11 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

`rewrite-input` 的三條新測試涵蓋：就地取代後模型只看到新輸入、舊回覆既不進請求
也不留版本群組；非末尾回合被拒且不寫入任何事件；生成失敗後表層完整還原成
原使用者訊息與原回覆。

## 尚未處理

**任意樓層隱藏。** 需要把 `hiddenPrefix` 從前綴陣列換成位置化表示，連帶修改
`tavern-chat.ts` 四條路徑的 `message_id - hiddenPrefix.length` 索引換算、
`projection.ts` 的 `[...hidden, ...visible]` 拼接，以及 `tavern-helper.ts` 的解析。
`validateRepresentable()` 裡那句 `DSH 会话暂时不能保留但隐藏一条卡片脚本聊天楼层`
就是這個表示法缺口的紀錄。

**部分恢復。** 放寬 `setHidden()` 的 `if (request.end < hiddenPrefix.length - 1)`
守衛、允許只恢復前綴尾端的 K 條，能把縮小隱藏範圍的成本砍掉一半，也少一次
「全部恢復」造成的身分重建。這是個小而收斂的改動，值得作為後續項。

**本輪狀態不隨輸入變更回退。** 就地重新生成會還原本輪起點的 MVU / Tavern 基準，
但訊息註記、插圖、故事工程沉澱不會跟著回退。這是確認過的取捨，界面上有寫出來。

## 部署

已於 **2026-09-03 03:20 UTC** 部署到 GCP `dsh-web`：停服務 → 備份 → 換檔 →
啟動 → 健康檢查 HTTP 200，`NRestarts` 維持 0。

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -DryRun
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -SkipBuild
```

（DryRun 已經建置過，所以正式那次用 `-SkipBuild` 沿用同一份產物。
`.bak-pre*` 在上一輪部署時已清掉，不需要再加 `-PruneBak`。）

- 備份：`/var/backups/dsh/agent-rp-20260903-032033`
- 回滾：`.\deploy-agent-rp.ps1 -Action rollback -BackupDir /var/backups/dsh/agent-rp-20260903-032033`

VM 上的 `.deployed-from.json` 記錄的是 `986e0e6a` + `gitDirty: true`，因為本輪
改動當時尚未提交。提交之後重跑一次部署，那份記錄就會指向確切的 commit
（檔案內容相同，等於只更新來源標記）。
