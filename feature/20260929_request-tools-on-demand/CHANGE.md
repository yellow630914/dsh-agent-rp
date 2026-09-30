# 请求按需携带工具：以往的思考过程不再进入上下文（2026-09-29）

角色回复的请求原本每一回合都带着 6～9 个工具定义（`web_search`、`inspect_actor`、
`revise_actor`、三个 `import_*`，开了插图还有三个图片工具）。现在默认**按需携带**：
只有这一回合用得到工具时才附上，平常的回合不带。

---

## 为什么这件事关系到注意力，而不只是省 token

DeepSeek 的 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) 用
「请求有没有带 `tools`」决定以往的 `reasoning_content` 怎么处理：

| 请求 | 以往各轮的思考过程 |
| --- | --- |
| 带 `tools` | **全部拼进上下文**；少传会回 400 |
| 不带 `tools` | 被忽略，不进上下文 |

Agent RP 从不删除历史里的 `reasoning` 区块（DSH 的 DeepSeek adapter 会把它们序列化成
`reasoning_content`），而工具是无条件注册的，所以**每个会话、每一回合**模型都在重读
自己以往的全部草稿。思考比正文长时，聊天记录里一半以上是这些草稿。

这不是某次改动引入的：`remember` 与 `import_*` 从 2026-08-12 起就在。9/16 加了
「发送给模型的内容」后才第一次有东西能拿来和「上下文已用」对照。

`llm-deepseek/src/types.ts` 的注释说「非工具回合会被忽略」，那是按「这一条消息有没有
工具调用」讲的；官方文件现行的规则是按「这次请求有没有带 `tools`」。

## 怎么判断「用得到」

`decideRoleplayRequestTools`（`src/roleplay-request-tools.ts`），只看这一次要送出的
消息和这一回合冻结的工具策略。以下任一成立就带：

- 设置为「每回合携带」
- 本回合已经调用过工具（中途拿掉会改变正在进行的那段推理的规则）
- `remember` 被开放——它本来就只在玩家说「记住」的那一回合开放
- 插图策略是「按场景判断」或「每回合尝试」；「仅在明确要求时」则看玩家这句话
- 玩家这句话附带了文件或图片（匯入工具要用）
- 玩家这句话要求搜索 / 查看或修改角色设定
- 出现任何本模块判断不了的工具（MCP 之类）——宁可不省，也不悄悄拿掉一个能力

只读**最新一句玩家发言**：上一回合要求过搜索，不会让之后每一回合都带工具。

## 状态栏不受影响

状态结算与独立核验是回复完成后另发的请求：只有一条证据消息、不带工具、不经过这个
接缝（`isAgentLoopDispatch` 为假），证据正文用 `textContent()` 取、读不到思考过程。
`apply_roleplay_state` 在主回合里从来没有开放过。有一条回归测试钉住：带 `purpose`、
未冻结的 Worker 请求原样交给 `next()`。

## 冻结进回合计划

选项进了 `toolGuidance.requestTools` 与 `plan.tools.behavior.request`，所以
**turn plan schema 6 → 7**，补了向 6 的投影（去掉这两个字段）。旧会话的记录没有这个
字段，重放时解析成 on-demand、按 schema 6 比对摘要——测试覆盖了这条路径。

## 预览面板

「发送给模型的内容」顶部多一行：

- 带工具时：列出原因，并提示以往 N 轮的思考过程约 X tokens 会被拼入上下文（不在总数里）
- 未带工具时：几个工具按需省略，以往的思考过程不进入上下文

## 已知的不一致

- DSH 在 `llm/stream` 之前就写下 `request/header`，所以会话信息里的「最近一次模型工具」
  和「上下文已用」展开后的「工具」一行，仍按省略前的工具计算。
- 带工具与不带工具的回合交替时，前缀缓存在切换的那一回合会失效一次。

## 验证

```
typecheck   host + client 通过
all         920 tests (904 passed, 16 skipped)
```

新增 `tests/roleplay-request-tools.test.ts`（9 条）与接缝测试 3 条。

**尚未在真实 DeepSeek API 上跑过。** 部署后要确认一件事：一段用过 `remember` 的会话，
历史里留有 `tool_calls` / `tool` 消息，之后不带 `tools` 的请求会不会被拒。若被拒，
先在设置里切回「每回合携带」。
