# 送出訊息後玩家自己那一行消失（2026-09-15）

回報：發送訊息時整個聊天 UI 錯位，**送出的訊息不見了**，新的角色回覆直接接在上一條
角色回覆後面。`玄元修仙-苏婉` 更嚴重，一次少六行。

同一目錄下有對應的問題單。這是 `be14fd4`（隱藏樓層改用真 `replace`）留下的回歸。

---

## 兩個改動疊在一起才炸

單獨看，兩個都合理：

1. **投影新增 `shadowedSeqs`** —— 收集被真 `replace` 移除的列，讓顯示計畫把它們藏起來
2. **DOM 轉接器的 user 那一圈補上 `hidden` 分支** —— 在那之前它會無視 `hidden`，
   等於一個沉默的漏洞

問題在於第 1 點**沒有區分兩種完全不同的 `replace`**：

| 誰寫的 `replace` | 原件該不該從畫面上消失 |
| --- | --- |
| 隱藏樓層（玩家要求） | **該** |
| **prompt-regex 提示詞視圖** | **不該** —— 人早就看過原件了 |

prompt-regex 用一次真 `replace` 把玩家那條訊息換成正則處理後的版本，**只給模型看**。
於是原件進了 `shadowedSeqs` → 計畫回傳 `hidden` → 第 2 點真的把它藏起來。

而替身是 `replace` 不是 append-origin，DSH 的人類 transcript 本來就不渲染它 ——
**原件被藏、替身不顯示，這一行就徹底消失。**

三段會話的真 `replace` 數量正好對上症狀：1 / 2 / **6**，全部是 prompt-regex。

## 修法

`applySurface()` 早就**跳過**帶 `PROMPT_REGEX_SOURCE_MARKER` 的事件 —— 它很清楚這類
訊息不屬於人看得到的那一層。`applyShadowedSeqs()` 是新寫的，漏了同一道判斷。補上。

修完重放三段真實日誌：`shadowedSeqs` 全部歸零，**沒有任何一行被藏**。

## 這件事的教訓

排查「正則對舊樓層不生效」時，我在苏婉那段的探針輸出裡印過 `shadowedSeqs: 6`，
當時把它讀成「這段會話隱藏過樓層」就跳過去了 —— 那六個其實全是 prompt-regex 的改寫，
**bug 當時就在螢幕上**。

一個和當下問題無關的數字出現在眼前時，值得花一秒確認它是什麼，而不是給它安一個
說得通的解釋。

另外：新增一個會影響畫面的集合時，該問的是「**哪些東西會進到這個集合**」，
而不是「我想讓哪些東西進來」。`replace` 不是只有一個生產者。

## 改動檔案

```
 src/projection.ts                  applyShadowedSeqs 跳過 prompt-regex 視圖
 tests/projection-contract.test.ts  回歸測試
```

## 測試

新增一條：對玩家訊息做一次 prompt-regex `replace` 之後，`shadowedSeqs` 必須是空的，
且投影 surface 保留的是**玩家真正送出的那一行**。

```
focused         756 tests (740 passed, 16 skipped)
smoke            68 passed
http             11 passed
session-launch   20 passed
```

`tsconfig.host.json` 與 `tsconfig.client.json` 兩份型別檢查都通過。

## 驗證

三段回報的會話（`魔都迷途-墨小凝 ERROR`、`ERROR 2`、`玄元修仙-苏婉`）的**真實日誌**
都重放過，修前會藏 1／2／6 行，修後 0 行。

**畫面本身尚未實機確認** —— 請發一則訊息確認自己那一行有出現。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
