# 发送给模型的内容：按来源拆开的请求预览（2026-09-16）

会话设置新增「发送给模型的内容」面板：**最近一次请求实际送出的顺序与正文**，
每一条按来源命名，世界书按条目、聊天记录按消息分开列出。默认只显示前缀摘要，
点开才载入原文。同一目录下有需求单。

---

## 为什么要在「组装的那一处」取，而不是重算一遍

最终那个数组是扁平的：预设模块、世界书条目、脚本注入、聊天行，到了这一层全都是
`{ role, content }`。而且它们会被**合并**——`worldInfoBefore` 一个模块里装着所有
命中的条目，同一 depth 的多个模块会并成一条消息。合并之后来源就没了，
再怎么读最终数组也还原不回来。

所以有两个选择：事后猜，或者在**还知道身份的地方**把身份带上。选了后者。

`RoleplayOrderedPrompt` 与 `RoleplayInChatPrompt` 各加一个可选的 `origin`，
在构造处填写（预设模块有 `identifier`，世界书条目有书名、条目名与命中的关键词）。
发送路径上没有任何代码读它，缺了就退化成「未归属」而不是让组装失败。

## 预览与实际送出的，必须是同一次组装

`prepareSillyTavernProviderMessages` 现在是
`prepareAttributedProviderMessages` 去掉归属后的样子——**一套实现，不是两套**。
`llm/stream` 接缝直接用带归属的那个，送出去的消息就是 `.map(item => item.message)`。
预览因此不可能显示一个模型没收到的顺序。

有一条回归测试专门钉这件事：两个函数对同一份输入产出的消息必须逐字相同
（新建消息的 `id` 每次都不同，只排除这一个字段）。

## 世界书：条目的位置是推出来的，而且会自证

`activeContent`（import/lorebook.ts）把命中的条目按 `insertionOrder`、再按 index
排序，然后按 `position` 分桶。`worldPlan` 里走同一个规则重建一次配对，
**并且比对长度**——对不上就整本退回「未归属」，而不是错位标注。

`inspectLorebooks` 把各书的 `inChat` 按书序 flatMap，所以按同样的书序拼接就能对上。

## 合并的消息怎么拆回去

in-chat 注入用 `\n` 合并，世界书标记用 `\n\n` 合并。拆的时候按分隔符试一遍，
**取「切出来的份数正好等于来源数」的那一个**；两个都不满足（比如某段内容为空）
就只列来源、不给正文，而不是猜一个错的切法。

## 正文不随摘要一起送

一次角色扮演请求动辄十万 token。摘要只带每条的来源、大小与开头一小段；
点开某一条时才单独取那一条的正文（`?index=N`，系统字段是 `-1`）。
面板一次只展开一条，所以从来不需要把整份提示词搬到浏览器。

## 只在内存里，不碰日志

每个会话保留**最近一次**请求，最多 8 个会话（重新写入会把该会话移到末尾，
淘汰的是最久没动的那个）。服务重启后清空——面板会直说「这段会话还没有发送过请求，
或者服务在那之后重启过」，而不是显示一个空列表。

**完全不写会话日志**，所以预览不会改变重放出来的任何东西。

## 顺带修掉的两件事

- **工具结果原本会显示成空的**。`tool-result` 把正文嵌在自己的 `content` 里，
  只读 `text` 块的话整条都是空——而这恰恰是长回合里占比最大的行。现在会展开，
  工具调用的 `arguments` 也算进去（那是实打实要付钱的字符）。
- **工具结果以 `user` 角色传输**，只看 role 会把它归到玩家自己的发言里。
  现在按内容判断。

## 界面

会话设置菜单 →「发送给模型的内容」。

顶部是**按来源汇总的 token 占比**（合并的消息按它的各个来源分摊，所以
一个 `worldInfoBefore` 模块不会把三十个世界书条目算到「预设」头上）——
哪一块占了大头，不用点开就看得见。

下面每条一行：序号、来源色标、名称、role、说明（世界书条目会显示
「书名 · 关键词 X」或「书名 · 常驻」）、开头摘要、token 数。点开载入正文；
合并的消息点开后是它的各个来源，每个来源还能再点开看自己的那一段。

## 改动文件

```
 src/prompt-origin.ts              新档：来源类型与世界书条目的描述
 src/prompt-preview-protocol.ts    新档：线格式
 src/prompt-preview.ts             新档：捕获、摘要、正文
 src/prompt-preview-http.ts        新档：唯读端点
 src/client/prompt-preview-client.ts 新档：浏览器端读取
 src/client/prompt-preview.tsx     新档：面板
 src/preset-prompt.ts              带归属的组装成为唯一实现
 src/roleplay-turn-plan.ts         世界书条目配对；各处填写 origin
 src/prompt-regex-stream.ts        在接缝处捕获（含「计划为空」那条路径）
 src/client/index.tsx              菜单项与挂载
 src/index.ts                      注册端点
```

## 测试

**prompt-preview**（6 条新增）——预览的顺序与送出的顺序逐字相同、世界书一条目一行
（含书名与命中关键词、各自的正文）、聊天一消息一行且工具结果不被当成玩家发言、
合并注入能拆回各自的模块、系统字段可单独读取并计入总量、没发送过的会话读成
「不存在」而不是「空」。

其余受影响的测试改为只断言摆放位置（新增的 `placed()` 去掉归属字段），
归属本身由上面那组测试覆盖。

```
focused         762 tests (746 passed, 16 skipped)
smoke            68 passed
http             11 passed
session-launch   20 passed
provider-seam    13 (12 passed, 1 skipped)
```

`tsconfig.host.json` 与 `tsconfig.client.json` 两份型别检查都通过。

## 验证状态

**端点已在 VM 上实测**：未捕获时回 `{"format":0,"available":true}`；
缺 sessionId 400、index 非整数 400、正文不在缓存 404、POST 405、跨站 403。
部署后的 `index.js` 与 `client.js` 都确认含有新代码，journal 无错误。

**面板本身还没点开过** —— 需要在一段会话里发送一条消息之后打开菜单确认。

## 部署

```powershell
powershell -File D:\dsh-tavern-script\deploy-agent-rp.ps1 -Action deploy
```
