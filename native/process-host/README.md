# DownanyProcessHost

`DownanyProcessHost` 是本地 Telegram Bot API 的唯一受控子进程宿主。它不解析
Telegram 参数，也不写业务文件，只负责把一个已经由 Electron 校验过的目标进程
放进可收敛的 Job/process group。

## 启动约定

```text
DownanyProcessHost --instance-id <opaque-id> -- <absolute-target> <arg> ...
```

控制通道由父进程作为额外的 fd/handle 传入（Unix 为 fd 3，Windows 为继承的 CRT
fd 3）。目标只继承 fd 0/1/2；fd 3 永远不会传给目标。宿主启动目标后，先在控制
通道写一行 JSON handshake：

```json
{"schemaVersion":2,"instanceId":"...","guardianPid":1,"guardianStartedAt":"...","targetPid":2,"targetStartedAt":"...","containment":"darwin_process_group","processGroupId":2}
```

在收到唯一的 `{"command":"resume"}` 前，目标不能执行用户代码。控制通道关闭、
父进程消失、收到未知命令或 JSON 不是单行对象时，宿主会终止整棵 Job/process
group，并等待成员清空后退出。目标根进程退出后，宿主仍等待后代清空，避免把“根退
出”误报成整棵树已收敛。

## 安全边界

- 目标必须在 `--` 后，且宿主拒绝缺少 `--instance-id`、空目标和额外控制参数。
- Windows 使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；macOS 使用
  `POSIX_SPAWN_START_SUSPENDED` 与独立 process group。
- handshake 只写 fd 3，目标 stdout/stderr 继续走父进程提供的 fd 1/2。
- 无法创建 Job、process group、父进程 wait handle 或 suspended target 时直接失败，
  不降级为裸 spawn。

构建后必须由 `scripts/test_process_host.py` 在对应平台运行真实父进程死亡、控制通道
关闭、根进程先退出以及中文/空格路径测试；未通过前不得复制到
`desktop/resources/process-host`。
