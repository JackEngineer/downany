import SwiftUI
import TraeDownloaderCore

struct HistoryView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedHistoryID: UUID?
    @State private var historyQuery: String = ""

    private var selectedHistoryTask: DownloadTask? {
        guard let selectedHistoryID else { return nil }
        return model.historyTasks.first { $0.id == selectedHistoryID }
    }

    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 16) {
                header

                HStack {
                    TextField("搜索标题、链接或上传者", text: $historyQuery)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            Task { await model.searchHistory(query: historyQuery) }
                        }
                    Button("搜索") {
                        Task { await model.searchHistory(query: historyQuery) }
                    }
                    .buttonStyle(.bordered)
                }

                ScrollView {
                    LazyVStack(spacing: 12) {
                        if model.historyTasks.isEmpty {
                            emptyListHint
                        } else {
                            ForEach(model.historyTasks) { task in
                                HistoryRow(
                                    task: task,
                                    isSelected: selectedHistoryID == task.id
                                ) {
                                    selectedHistoryID = task.id
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
                task: selectedHistoryTask,
                emptyTitle: "尚未选择历史记录",
                emptyMessage: "点击左侧任一记录查看详情，并执行重新下载、重试、打开源链接、打开文件位置或删除记录等操作。",
                actions: historyActions(for: selectedHistoryTask)
            )
            .frame(minWidth: 360, idealWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .onAppear(perform: syncSelection)
        .onChange(of: model.historyTasks) { _, _ in
            syncSelection()
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("历史记录")
                    .font(.title2.weight(.semibold))
                Text("保留平台、标题、上传者与下载结果。")
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 8) {
                Text("共 \(model.historyTasks.count) 条")
                    .foregroundStyle(.secondary)

                Button("打开下载目录") {
                    model.openDownloadDirectory()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var emptyListHint: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("暂无历史记录")
                .font(.headline)
            Text("下载任务完成或失败后，会在这里保留历史条目，方便重新下载或查看文件位置。")
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
        if let selectedHistoryID, model.historyTasks.contains(where: { $0.id == selectedHistoryID }) {
            return
        }
        selectedHistoryID = model.historyTasks.first?.id
    }

    private func historyActions(for task: DownloadTask?) -> [TaskDetailAction] {
        guard let task else {
            return []
        }

        var actions: [TaskDetailAction] = []

        switch task.status {
        case .downloading:
            actions.append(TaskDetailAction("暂停") {
                Task { await model.pause(task: task) }
            })
            actions.append(TaskDetailAction("取消", role: .destructive) {
                Task { await model.cancel(task: task) }
            })
        case .paused:
            actions.append(TaskDetailAction("继续下载") {
                Task { await model.resume(task: task) }
            })
            actions.append(TaskDetailAction("取消", role: .destructive) {
                Task { await model.cancel(task: task) }
            })
        case .pending:
            actions.append(TaskDetailAction("取消", role: .destructive) {
                Task { await model.cancel(task: task) }
            })
        case .failed:
            actions.append(TaskDetailAction("重试") {
                Task { await model.retry(task: task) }
            })
        case .cancelled:
            actions.append(TaskDetailAction("重试") {
                Task { await model.retry(task: task) }
            })
        case .completed:
            actions.append(TaskDetailAction("重新下载") {
                Task { await model.redownload(task: task) }
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
        actions.append(TaskDetailAction("删除记录", role: .destructive) {
            Task { await model.deleteHistoryTask(id: task.id) }
        })

        return actions
    }
}

private struct HistoryRow: View {
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
                    Text(task.videoInfo.uploader.isEmpty ? "未知上传者" : task.videoInfo.uploader)
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

            Text(task.filePath.isEmpty ? "未写入文件路径" : task.filePath)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            HStack(spacing: 12) {
                Text(formattedDate(task.createdAt))
                Text(task.completedAt.map { formattedDate($0) } ?? "未完成")
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

    private func formattedDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}
