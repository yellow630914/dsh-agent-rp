# [Feature] 归档会话的查询、还原与删除

### 这个能力解决什么问题？

会话管理

会话归档之后就**看不见也拿不回来**。归档集合只增不减，而且没有任何界面能看到里面有什么。

### 期望的行为

1. 这更像是针对 DSH 的插件功能，不只是 agent-rp
2. 看见现在被归档的 session
3. 删除这些被归档的 session
4. 还原这些被归档的 session
5. 还原能直接生效最好；不行的话单纯改文件也可以，**以不要改到 Host 为准**

### 提交前确认

- [x] 我已检查上述内容，不包含 API Key、私人对话或完整 Session Log。

---

### 补充：DSH 提供了什么

| | 有吗 |
| --- | --- |
| `workspaceRegistry.archivedSessionIds`（读） | ✔ |
| `archiveSession(id)`（加入） | ✔ |
| **unarchive** | ✘ |
| **delete session** | ✘（`sessionPersistence` 也没有） |

DSH 自己的注释写着 *"an archived session keeps its `sessionIds` slot so unarchiving
restores its position"`*——概念是设计好的，但没开接口。

归档集合存在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`，
而 registry 在内存里 cache 了这份状态：**热改文件会被它自己的下一次写入整份盖掉**。

### 补充：所以分成两半

- **看见**：插件里一个只读的 HTTP 面板，读 `workspaceRegistry` 配
  `sessionPersistence.list()` 拿标题与大小。完全不碰 Host，热的也安全。
- **还原与删除**：放进部署脚本，在**服务停止的窗口内**完成，改完再启动并跑健康检查。
  没有第二个写者可以竞争，也没有内存状态会盖掉我们。

删除会先把整份日志完整备份到 `/var/backups/dsh` 再移除，并顺手清掉投影缓存与
归档集合里那个指不到东西的 id。
