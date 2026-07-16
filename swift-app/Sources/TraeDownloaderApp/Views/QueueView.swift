import SwiftUI
import TraeDownloaderCore

struct QueueView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedTaskID: UUID?

    private var selectedTask: DownloadTask? {
        guard let selectedTaskID else { return nil }
        return model.queueTasks.first { $0.id == selectedTaskID }
    }

    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 16) {
                header

                ScrollView {
                    LazyVStack(spacing: 12) {
                        if model.queueTasks.isEmpty {
                            emptyListHint
                        } else {
                            ForEach(model.queueTasks) { task in
                                QueueRow(
                                    task: task,
                                    isSelected: selectedTaskID == task.id
                                ) {
                                    selectedTaskID = task.id
                                }
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .frame(minWidth: 680, idealWidth: 760, maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            TaskDetailPane(
                task: selectedTask,
                emptyTitle: "尚未选择任务",
                emptyMessage: "点击左侧任一任务查看详情，并执行暂停、继续、取消、重试、打开源链接或打开文件位置等操作。",
                actions: queueActions(for: selectedTask)
            )
            .frame(minWidth: 360, idealWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .onAppear(perform: syncSelection)
        .onChange(of: model.queueTasks) { _, _ in
            syncSelection()
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("下载队列")
                    .font(.title2.weight(.semibold))
                Text("管理等待、运行、暂停和失败任务。")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("打开下载目录") {
                model.openDownloadDirectory()
            }
            .buttonStyle(.bordered)
        }
    }

    private var emptyListHint: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("队列为空")
                .font(.headline)
            Text("新增下载后，任务会在这里展示，并可直接暂停、继续或取消。")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.secondary.opacity(0.08))
        )
    }

    private func syncSelection() {
        if let selectedTaskID, model.queueTasks.contains(where: { $0.id == selectedTaskID }) {
            return
        }
        selectedTaskID = model.queueTasks.first?.id
    }

    private func queueActions(for task: DownloadTask?) -> [TaskDetailAction] {
        guard let task else {
            return []
        }

        var actions: [TaskDetailAction] = []

        switch task.status {
        case .downloading:
            actions.append(TaskDetailAction("暂停") {
                Task { await model.pause(task: task) }
            })
        case .paused:
            actions.append(TaskDetailAction("继续下载") {
                Task { await model.resume(task: task) }
            })
        case .failed:
            actions.append(TaskDetailAction("重试") {
                Task { await model.retry(task: task) }
            })
        case .completed:
            actions.append(TaskDetailAction("重新下载") {
                Task { await model.redownload(task: task) }
            })
        case .pending:
            actions.append(TaskDetailAction("取消") {
                Task { await model.cancel(task: task) }
            })
        case .cancelled:
            actions.append(TaskDetailAction("重试") {
                Task { await model.retry(task: task) }
            })
        }

        actions.append(TaskDetailAction("打开源链接") {
            model.openSourceURL(for: task)
        })
        actions.append(TaskDetailAction("打开文件位置") {
            model.revealDownloadedFile(for: task)
        })
        actions.append(TaskDetailAction("打开下载目录") {
            model.openDownloadDirectory()
        })

        if task.status == .downloading {
            actions.append(TaskDetailAction("取消", role: .destructive) {
                Task { await model.cancel(task: task) }
            })
        }

        return actions
    }
}

private struct QueueRow: View {
    let task: DownloadTask
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.displayTitle)
                        .font(.headline)
                        .lineLimit(2)
                    Text(task.videoInfo.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 6) {
                    Text(task.status.displayName)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.thinMaterial, in: Capsule())

                    Text(task.videoInfo.platform.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ProgressView(value: task.progress / 100.0)
            HStack(spacing: 12) {
                Text(String(format: "%.1f%%", task.progress))
                Text(task.speed)
                Text(task.eta)
                Spacer()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isSelected ? Color.accentColor.opacity(0.8) : Color.secondary.opacity(0.12), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
    }
}
