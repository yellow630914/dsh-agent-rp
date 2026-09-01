# [Bug] 迁移 SillyTavern 聊天时，角色绑定的世界书不会进入新会话

### 问题发生在哪里？

聊天迁移 / 世界书

### 实际发生了什么？

在「迁移聊天」面板里选一张资源中心已有的角色卡，迁移完成后世界书面板是空的。
同一张角色卡走「开始游玩 → 角色对话」则一切正常。

根因在 `src/session-launch.ts` 的 `prepareAgentRpSession()`：`character` 分支会调用
`appendCharacterWorldSessionSeed()` 把角色绑定的世界书写成 actor 快照，`chat`（迁移）
分支只做了 `seedWithPreset()`，完全没有这一步。而 `characters.resolve()` 返回的
`worldBinding` 早就在作用域里，只是没有被使用：

```ts
const character = characters.resolve(request.characterId)   // ← 带 worldBinding
const migrationSeed = createSillyTavernMigrationSeed(/* … */)
return {
  seed: seedWithPreset(migrationSeed, presets, request.presetId),   // ← 世界书从未被附加
  title: character.detail.displayName,
}
```

`readSessionLorebookSourcesFromEvents()`（`src/world-info-configuration.ts`）有一条旧版
兼容回退：**当会话里没有任何 actor 世界快照时**，才拿角色卡里的 `character_book` 顶上。
所以修复前的实际状态是：

- 角色卡内置书靠这条回退侥幸生效，而且用的是卡里的旧副本，不是世界资源的当前内容；
- 用户在资源中心绑定的世界书（`binding.additional`，以及被替换过的 `primary`）**全部丢失**；
- 用户把主世界绑定清成 `null` 的卡，迁移后反而仍会拿到卡里的内置副本。

### 最短复现步骤

1. 导入一张**没有**内置世界书的角色卡。
2. 在资源中心导入一本世界书，并把它绑定到这张角色卡。
3. 在角色会话里附加一份 SillyTavern JSONL，迁移面板选择这张角色卡，完成迁移。
4. 打开「会话设置 → 世界书」。

角色卡带内置书时症状较轻（还剩一本，但那是回退来的旧副本，绑定的其他书仍然丢失）。

### 预期行为

迁移得到的会话应该和「开始游玩」解析出**完全相同**的世界书组合，
包括拆分出的内置书快照与用户后来绑定的世界，顺序也一致。

### 本地错误或诊断

对同一张卡、同一份绑定，实测两条路径解析出的世界书来源：

```
角色卡有内置书 ＋ 用户另外绑一本外部书
  迁移      1 本  character:library:card-a3d93d5a…        「内置书」（回退副本）
  开始游玩  2 本  character:library:world-info-14e9c81f…  「内置书」
                 character:library:world-info-33f0ad6f…  「外部世界书」

角色卡无内置书，只有用户绑定的外部书
  迁移      0 本
  开始游玩  1 本  character:library:world-info-33f0ad6f…  「外部世界书」
```

### 相关资源与公开来源

无需私有资源即可复现，任意角色卡加任意世界书都可以。

### Agent RP 版本或提交

main `f8b98d9`（2026-08-31）。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：修法与已知影响

`chat` 分支补上与 `character` 分支相同的一步：

```ts
seed: seedWithPreset(
  appendCharacterWorldSessionSeed(migrationSeed, character.worldBinding, worldInfos),
  presets,
  request.presetId,
),
```

`appendCharacterWorldSessionSeed` 与 `worldInfos` 本来就在这个函数的作用域里，
没有新增 import 或依赖。

加上 actor 快照之后 `hasActorWorldSnapshot` 成立，内置书的回退自动失效，
**不会出现同一本书重复两遍**；投影侧的 `provisionalLibraryCardLorebook`
（`src/projection.ts`）也会把角色卡种子带来的 `cardLorebook` 换成第一本 actor 世界。

已知影响：

1. **世界书 source id 形状改变**（`character:library:card-…` → `character:library:world-info-…`）。
   世界书条目覆写以 bookId 为键，但只影响新建的迁移会话；已有会话重放自己的事件日志，
   不经过 `prepareAgentRpSession()`，不需要数据迁移。
2. **`charLoreBook` / Tavern `getCharWorldbookNames` 的取值来源改变**。取第一本
   `source === 'character'` 的名字；拆分出的世界资源保留了 `character_book.name`，
   常见情况下字符串不变，只有用户改过世界书名或换过主世界时才不同——而那正是应该跟随的值。
3. **没有绑定时行为不变**。`worldBinding === undefined`（旧 Host 或未配置绑定库）
   时函数原样返回，内置书回退继续生效。
4. **启动权限预检不变**。`tavern-resource-library-preflight.ts` 没有任何 world 分支。

### 补充：一个实测出来的成本

`appendCharacterWorldSessionSeed()` 是**每本书 `structuredClone(整个 seed)` 再
`Session.create()` 校验一次**。`character` 路径的 seed 只有 7 个事件，无所谓；
迁移 seed 是上千个事件，成本量级不同。实测（538 KB / 300 条消息的 JSONL
→ 1502 个 seed 事件，4 本绑定世界）：

```
prepare（不含世界书） 58 ms   →   append 4 本世界书 72 ms
```

世界书追加比整个迁移准备还贵，且随 `O(书数 × 事件数)` 线性增长；绑满 16 本约 290 ms。
这是一次性的启动开销，可以接受。若之后需要优化，解法是加一个
「先全部追加、最后只 `Session.create()` 一次」的批量版本。

### 补充：尚未处理的第二步

迁移面板目前没有会话级世界书选择器，`chat` 请求也在解析层就拒绝 `worldInfoIds` 字段。
要补需要动三处：`session-launch.ts` 的请求解析、`LibrarySessionLaunchRequest` 协议、
以及迁移对话框 UI。

**注意一个陷阱**：若照抄 `character` 分支写成
`seedWithWorldInfos(seed, worldInfos, request.worldInfoIds, characterWorldIds)`，
当 `worldInfoIds` 为 `undefined` 时它会回退到 `worldInfos.defaultIds()`，
也就是资源中心里标记为「新会话默认」的世界书会全部自动挂上。
这与 `character` 路径一致，但对迁移是不是想要的行为需要另外决定。
