# [Bug] 从空白会话迁移聊天时，下拉选中的角色卡被静默丢弃

### 问题发生在哪里？

聊天迁移

### 实际发生了什么？

在「迁移聊天」里用下拉选单选了资源中心已有的角色卡，迁移成功、没有任何错误，
但产出的会话**完全没有角色卡**。

服务器上那个会话的事件统计：

```
agent-rp/character-card-seed  : 0     ← 一个卡片种子都没有
agent-rp/sillytavern-chat-import: 1
```

头部没有 `parentSession`，是全新建立的会话；前几个事件是
`sillytavern-chat-import` 开头接着一连串 turn —— 正是
`prepareAgentRpSession()` 的 `request.characterId === undefined` 分支产出的形状。

也就是说：launch 请求根本没带 `characterId`。

### 根因

界面的契约有四个参数：

```ts
readonly prepareChatMigration: (
  sessionId: SessionId,
  chatFile: File,
  cardFile?: File,
  characterId?: string,      // ← 下拉选单选的就是这个
) => Promise<PreparedChatMigration>
```

但**空白会话**入口注册进去的那个包装只有三个，也没有转发：

```ts
const prepareChatMigrationFromBlankSession = async (
  sourceSessionId: SessionId,
  chatFile: File,
  cardFile?: File,                                        // ← 缺 characterId
): Promise<PreparedChatMigration> => {
  ...
  return prepareChatMigration(sourceSessionId, chatFile, cardFile)   // ← 没有转发
}
```

**TypeScript 抓不到**：参数较少的函数可以赋值给参数较多的函数类型（这是刻意的，
`arr.map(x => …)` 才能成立），所以三参数的包装是合法的四参数实现，两份 tsconfig
都不会出声。

`cardFile` 有被转发，所以「从文件选择」一直是好的——这就是为什么问题到现在才浮出来。

### 影响范围

| 入口 | 从文件选卡 | 下拉选现有卡 |
| --- | --- | --- |
| 已开始的会话 → 迁移聊天 | 正常 | 正常 |
| **空白会话 → 迁移聊天** | 正常 | **静默丢失** |

而且是静默的：没有错误、没有警告，迁移照样成功，只是产出一个没有角色卡的会话。
后续症状（隐藏楼层时报 `this roleplay Session has no imported Character Card`）
反而是第一个把它暴露出来的东西。

顺带：这也意味着
[迁移聊天带上角色绑定的世界书](../../feature/20260901_migration-worlds-and-memory-io/01-chat-migration-drops-character-bound-worlds.md)
在这条入口上等于没有作用——没有卡就没有绑定。

### 最短复现步骤

1. 新建一个空白会话
2. 打开「迁移聊天」，选一份 JSONL，并在「角色卡（可选）」下拉里选一张已有角色卡
3. 完成迁移，检查新会话是否有角色卡

### 预期行为

两个入口的行为应该一致：下拉选中的角色卡要进入新会话。

### Agent RP 版本或提交

`2966d50` 及此前所有版本。

### 运行环境

Ubuntu 24.04 / Node 22.23.2 / web profile（systemd 服务）/ GCP e2-small

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：修法

补上第四个参数并转发，同时把包装改成**由共享契约标注类型**而不是各自重新声明：

```ts
const prepareChatMigrationFromBlankSession: HeaderProps['prepareChatMigration'] = async (
  sourceSessionId, chatFile, cardFile, characterId,
) => { … }
```

这样参数列表只写一次，从契约推导。**要说清楚的是：这不会让编译器捕获同类遗漏**
——参数数量的可赋值性规则依旧成立，少写一个参数仍然合法。它只是让「这个函数实现
的是哪个契约」在定义处可见，而不是靠人去比对两处声明。

真正能挡住这类问题的是端到端测试（断言空白会话迁移送出的 launch 请求带
`characterId`），但那需要完整的客户端上下文，本次没有补。

### 补充：已经产生的会话

已经因为这个 bug 建立的、没有角色卡的会话不会自动修复。它们仍然可以正常对话，
但没有角色卡的世界书绑定、卡片前端与酒馆脚本；需要角色卡的功能（例如隐藏楼层，
见同目录另一份问题单）会失败。要修只能重新迁移一次。
