# 分支约定

详见 [roadmap.md](roadmap.md) 第 6 节与执行计划「分支与工作区管理」。

- `main` 始终可发布；一叶子任务一分支一 PR。
- 命名：`feat/m{N}-{slug}` / `chore/{slug}` / `fix/{slug}` / `spike/{slug}`。
- 并行用 `.worktrees/<branch>/`；合入后删分支与 worktree。
- 归档：`archive/*`（例：`archive/pornhub-search-support`，功能已在 main，保留历史测试参考）。
