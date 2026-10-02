# Linux 服务器部署

普通 Linux 与 Termux 使用不同的 Node.js、原生模块和文件系统环境。本页只适用于常规 Linux 桌面或服务器；Android 请等待单独的 Termux runner 完成实机验收。

## 安装 Agent Host

创建一个不具备 root 权限的服务用户，并始终以这个用户安装、更新和运行 DSH。以下示例使用当前登录用户；自定义 `DSH_HOME` 必须是绝对路径，并在安装和生成服务单元时保持一致。

管理员代服务用户执行安装器时，推荐先用 `sudo -iu <用户>` 进入该用户的登录环境。安装器也会在工具检查前进入目标用户的 `HOME`，避免 Corepack 读取管理员的私有当前目录；相对的本地 `--runner-source-base` 会在切换目录前解析。

```bash
installer_path="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/yellow630914/dsh-agent-rp/main/scripts/install-linux.sh -o "$installer_path"
bash "$installer_path"
```

安装器依次完成以下检查：

- Node.js 为 22.19+ 或 24+，pnpm 为 11 或更高版本；
- runner 文件与补丁来自同一份 `host-runner` 锁定配置；
- DSH 报告版本为当前验收版本；
- `Session.prototype.appendIgnorable` 确实存在；
- Agent RP 已写入 web profile、加入 bundle 列表并落盘。

安装完成后的启动入口是 `$DSH_HOME/bin/dsh-agent-rp`。它从自身位置恢复并导出同一个 `DSH_HOME`，因此 systemd 不会因缺少交互式 shell 环境而切换数据目录。

## 生成 systemd 服务

先以服务用户运行一次安装器，再以同一用户生成服务单元。`--print-systemd` 只向标准输出写入 unit，不安装服务，也不会启动 DSH：

```bash
bash "$installer_path" --print-systemd > ./dsh-agent-rp.service
```

使用 Cloudflare Tunnel 或反向代理且外部 authority 为 `rp.example.com` 时，把它明确加入生成结果：

```bash
bash "$installer_path" --print-systemd --trusted-host rp.example.com > ./dsh-agent-rp.service
```

审阅生成文件后，由管理员安装并启动：

```bash
sudo install -m 0644 ./dsh-agent-rp.service /etc/systemd/system/dsh-agent-rp.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-agent-rp.service
sudo systemctl status dsh-agent-rp.service
```

进程失败时会重启并受启动限速约束，不使用 `Restart=always`。unit 不假设工作目录，也不修改 DSH 数据。它会可选读取 `/etc/dsh-agent-rp.env`；文件不存在不会阻止启动。模型凭据优先保存在 DSH 的凭据存储中；确需使用环境变量时，由管理员创建权限受限的环境文件，不要把密钥写入 unit、仓库或 Issue。停止与日志命令为：

```bash
sudo systemctl stop dsh-agent-rp.service
sudo journalctl -u dsh-agent-rp.service -n 100 --no-pager
```

更新时先以同一服务用户重新运行安装器，再重启服务：

```bash
bash "$installer_path"
sudo systemctl restart dsh-agent-rp.service
```

## 反向代理安全

DSH 保持绑定在回环地址。不要传入 `--host 0.0.0.0`，也不要直接开放本地端口。Cloudflare Tunnel 或反向代理应转发到 `http://127.0.0.1:3080`。

`--trusted-host` 接受规范的 `host` 或 `host:port` authority，只决定哪些 Host 值可以抵达 DSH API。它不是身份认证，也不会限制已经获准 Host 下的用户。公网入口必须由 Cloudflare Access、具备认证的反向代理或等价的独立认证层保护。

不要在 profile 的 `node_modules` 中手工覆盖 `@deepseek-ai/dsh-session`。Agent Host 将补丁隔离在 `$DSH_HOME/runners/agent-rp` 并由 pnpm 锁文件校验；手工副本可能改变整个 profile 的模块解析结果并导致 Host 无法启动。
