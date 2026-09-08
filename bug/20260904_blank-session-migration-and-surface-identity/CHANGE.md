# 遷移丟失角色卡 ＋ 表層重寫複製訊息身分（2026-09-04）

樓層面板上線後回報兩個錯誤，追下去是**兩個既有缺陷**，都不是樓層面板寫錯，
但都是它讓人第一次踩到。

同一目錄下有兩份問題單。樓層面板那一輪見
[20260903_inline-regenerate-and-floor-visibility](../../feature/20260903_inline-regenerate-and-floor-visibility/CHANGE.md)。

---

## 一、空白會話遷移丟掉下拉選的角色卡

回報：隱藏樓層時報 `this roleplay Session has no imported Character Card`，
但那個會話是用「遷移聊天」並且**確實用下拉選單選了角色卡**建立的。

伺服器上的證據很直接 —— 那個會話 `agent-rp/character-card-seed` 是 **0**，
沒有 `parentSession`，事件形狀正是 `prepareAgentRpSession()` 的
`characterId === undefined` 分支。launch 請求根本沒帶 `characterId`。

根因在客戶端：介面契約有四個參數，但**空白會話**入口註冊的包裝只寫三個，
也沒有轉發。

```ts
const prepareChatMigrationFromBlankSession = async (
  sourceSessionId, chatFile, cardFile,        // ← 缺 characterId
) => {
  return prepareChatMigration(sourceSessionId, chatFile, cardFile)   // ← 沒有轉發
}
```

**型別檢查抓不到**：參數較少的函式可以指派給參數較多的函式型別（這是刻意的規則），
所以三參數的包裝是合法實作。`cardFile` 有轉發，所以「從文件選擇」一直是好的 ——
這就是問題到現在才浮出來的原因，而且它**完全靜默**：沒有錯誤、遷移照樣成功。

**修法**：補上參數並轉發，同時把包裝改成由共享契約標註型別
（`HeaderProps['prepareChatMigration']`），讓參數列表只寫一次。

> 要說清楚：**這不會讓編譯器捕獲同類遺漏** —— 可賦值性規則依舊成立，
> 少寫一個參數仍然合法。它只是讓「這個函式實作的是哪個契約」在定義處可見。
> 真正能擋住的是端到端測試，那需要完整的客戶端上下文，本次沒有補。

## 二、表層重寫複製了訊息身分

回報：成功隱藏樓層之後，下一輪失敗於
`Roleplay external context "989c9182-…" is unavailable or ambiguous`，而且**持續失敗**。

伺服器上錯誤訊息裡那個 id **確實在日誌裡出現兩次**。

根因：`rewriteSurface()` 會把表層項目全部重新追加，而 `appendEntry()`
對既有項目是原封不動地重送 `event.data` —— 連 `id` 一起。但 `dsh-llm` 的契約
說的恰好相反，`createUserMessage` 的簽章是 `id?: never`，文件寫
「a fresh stable identity」。重新追加**繞過了工廠**，讓日誌裡出現兩個聲稱同一身分
的訊息，`roleplay-turn-context.ts` 以 id 建索引時就判定歧義。

同樣形狀的讀取者還有 `session-roleplay-turn-plan.ts` 與
`roleplay-staged-state-settlement.ts`。

**修法**：重新追加時用工廠重建訊息取得新身分，**來源與內容照舊保留，只重鑄身分**。
`tool/result` 刻意不動 —— 它靠 `toolCallId` 關聯、沒有讀取者按身分索引它，
在沒有真實故障佐證前不去擾動工具配對。

---

## 沒有修的第三項

`prepareTavernHelperState()` 在 `executeTavernHelperMutation()` 的最前面被無條件呼叫，
沒有角色卡就拋錯，所以**沒有角色卡的會話仍然不能隱藏樓層**。

修好第一項之後，新的遷移都會帶卡，這條路不再容易碰到；但已經產生的
card-less 會話仍會遇到。這次確認過先不動它 —— 它會影響所有酒館變更，
範圍比前兩項廣。

## 已經受影響的會話不會自動修好

- **沒有角色卡的會話**：需要重新遷移一次才會帶上卡。
- **已經有重複 id 的會話**：那一對事件仍在日誌裡，準備回合時還是會失敗。
  要恢復，需要讓那條外部上下文訊息不再進入可見範圍 —— 例如再調整一次隱藏範圍
  把它移出表層，或從該輪之前另開分支。

## 改動檔案

```
 src/client/index.tsx     |  18 ++++--   轉發 characterId，改用共享契約標註
 src/tavern-chat.ts       |  26 ++++--   重新追加時重鑄訊息身分
 tests/tavern-chat.test.ts|  36 ++++++   重複身分迴歸測試
```

測試斷言：隱藏前綴後，日誌裡所有 `user/message` 的 id 兩兩不重複；
原事件保留自己的身分、重新追加的複本拿到新的；plugin 來源與正文都照舊保留。

## 驗證

```
focused          730 tests (714 passed, 16 skipped)
smoke             66 passed
session-launch    19 passed
http              11 passed
turn-recovery      9 passed
provider-seam     13 passed (12 passed, 1 skipped)
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

> 期間有一次 focused 出現 1 個失敗，堆疊是 `Pipe.onStreamRead`、而且測試總數
> 只跑到 692（正常是 730），像是輸出串流被截斷造成的環境問題；隨後三次完整重跑
> 都是全綠。記在這裡以免之後又看到同樣的抖動時誤判。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1
```
