# Legacy UIs（已冻结）

Electron + Sidecar 是唯一产品主线。本目录仅保留历史实现，**不再新增功能**，也不进入 CI。

| 路径 | 内容 |
|------|------|
| `ui/` | 原 `src/ui/`（PyQt6） |
| `main.py` | PyQt 入口：`python legacy/main.py` |
| `swift-app/` | 原 SwiftUI 并行版 |
| `tests-ui/` | 原 `tests/ui/` |

打包 Swift（若需要）：`PACKAGE_DIR` 已改指向本目录，见 `scripts/package_swift_app.sh`。
