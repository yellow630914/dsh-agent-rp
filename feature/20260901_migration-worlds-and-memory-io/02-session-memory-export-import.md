# [Feature] 会话记忆的导出与导入

### 这个能力解决什么问题？

角色记忆 / 资源复用

持久记忆目前只能留在产生它的那段会话里。跨会话只有一条通路：「开始角色对话」时
勾选「带上当前会话的有效记忆」（`session-launch-http.ts` 的 `memory: 'copy-active'`），
而它硬性限制在**同一张角色卡**，也不能落地成文件、不能在设备之间搬、
不能在会话已经开始之后再补进去。

期望能把一段会话的有效记忆导出成文件，再导入到任意一段角色会话。

### 期望的行为

**导出**：记忆管理对话框给出「导出」，把当前有效记忆写成 JSON 文件。

**导入**：同一个对话框给出「导入」，选一个文件把其中的记忆并入当前会话。

已确定的策略：

1. 导入前先完整验证，维持主题唯一性；有重复就**整批拒绝**，不做部分导入
2. seq 一律以当前 session 为准，**忽略文件里的 seq**
3. 验证通过后才开始派发 seq 并写入
4. 中途出错能 rollback 就 rollback，不行则停止导入
5. 导入进来的记忆在界面上要能与「由你保存」「从上一段带来」区分开
6. 跨角色导入**放行**
7. 一次上限 200 条

### 现有的相关实现

- `GET /api/agent-rp/memory` 已经返回完整的有效记忆快照（`src/memory-http.ts`）
- `/rp-memory` 已支持 add / correct / forget（`src/memory-command.ts`）
- `agent-rp/memory-seed` 事件与 `appendAgentRpMemorySeed()` 已服务于
  「带上当前会话的有效记忆」（`src/memory.ts`）

### 设计上必须处理的约束

**1. 记忆 id 由事件 seq 派生。** `memory-<seq>` 与 `memory-seed-<seq>-<index>`
（`MEMORY_ID_PATTERN`）。一条 `command/done` 的 add 分支只能铸一个 id，
所以批量导入要么发 N 条命令，要么让一条记录承载整批。

**2. 主题唯一性是大小写与空白折叠后的比较。** `memorySubjectKey()` 做
`trim()` + `toLocaleLowerCase()`。需要查两层：文件内部两两之间、以及与当前会话
的有效记忆之间。注意 `applySeedRecord()`（继承记忆那条路径）**不查主题冲突**，
只查 id 碰撞，与 add 分支的语义并不一致——导入必须自己把这层补上。

**3. 读取器会抛异常，而且在提示词路径上。** `readAgentRpMemoryHistory()` 对任何
无法验证的记录直接 `throw`，它被 `src/prompt.ts`、`src/roleplay-turn-plan.ts`、
回合结算与 HTTP 路由调用。**一条折不回来的记录会让该会话之后每一轮都失败**，
而 append-only 的日志拿不回来。

**4. 导入文件是不可信输入，且最终进入系统提示。** 长度上限、条数上限、
字段白名单是这里的全部防线；文件里的 `id` / `sourceEventSeq` / `version` 一律不能采信。

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：采用的实现路线

在 `/rp-memory` 上新增 `operation: 'import'`，而不是直接追加 `agent-rp/memory-seed` 事件。
理由：`command/done` 是标准机制，**不需要打过补丁的 Host**
（`appendAgentRpSessionEvent()` 在缺少 `appendIgnorable` 的 Host 上会直接拒绝写入）；
与其他所有 RP 变更同路径；`applyCommandRecord()` 已有重放校验骨架。

**原子性来自「一条 `command/done` 承载整批」**，所以策略 4 担心的 rollback 不会发生：

1. Host 先追加 `command/run`——seq 在这一刻由 Host 分配，处理器从
   `session.events.at(-1)` 取得
2. 处理器在纯内存里跑完整批验证，任何一条不过就 `throw`
3. 验证通过才返回结果，Host 追加**一条** `command/done`
4. 记忆状态完全由这条 `command/done` 在重放时产生

不存在「派发 seq 中途失败」，也不存在半截导入；验证失败时会话里只留下一对
`command/run` + `command/done(error)`，记忆零变化。

> 对照：若走「连发 N 条 `/rp-memory add`」，才会真的出现半截导入且无法回退。

id 铸成 `memory-seed-<sourceEventSeq>-<index>`，沿用既有 id 文法，
**没有改动 `MEMORY_ID_PATTERN`**。同一个 seq 不可能既是 `command/run`
又是 `agent-rp/memory-seed` 事件，所以与继承记忆的 id 不会碰撞。

### 补充：写入前自检

`src/memory-command.ts` 的 `assertFoldsBack()`：把还没落盘的记录组成一个临时
`command/done` 事件，用真正的 `readAgentRpMemoryHistory()` 折一遍，
并检查有效记忆数量是否等于预期，通过了才返回。

把读取器本身当成验证器，可以从根上消除上面第 3 条约束那一类风险。
这个自检对 add / correct / forget / import **四种操作都会跑**；
代价是每次记忆操作多一次全量重放，而记忆操作很少且都是用户触发的。

### 补充：`imported` 标签

`AgentRpMemoryRecord` 新增 `origin?: 'imported'`。必须加字段的原因是**导入与手动新增
都指向 `command/run`**，只看来源事件类型分不出来。`memory-http.ts` 先看 `origin`
再看事件类型，`AgentRpMemoryView.source` 增加 `'imported'`，界面显示「从文件导入」。

### 补充：导出格式

```json
{
  "format": 0,
  "kind": "agent-rp-memory-export",
  "exportedAt": "2026-09-01T00:00:00.000Z",
  "memories": [{ "kind": "fact", "subject": "…", "text": "…" }]
}
```

只有 `kind` / `subject` / `text` 跨越文件边界。**刻意不写 `id` 和 `sourceEventSeq`**：
导入时反正会忽略，写进去只会让下游工具误以为它们有意义。
文件不带角色身份，跨角色导入因此是天然放行的。

### 补充：为什么上限是 200

一次导入是**一条**持久记录，之后每次 `readAgentRpMemoryHistory()` 都要重新解析它；
而且每一条有效记忆都会渲染进系统提示。两项成本都随条数增长，所以这个数字
刻意远低于 `agent-rp/memory-seed` 事件本身的 1000 上限。
命令走 `/api/agent-rp/command` 的 4 MB 限制，200 条不构成传输压力。
