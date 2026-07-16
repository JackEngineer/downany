import SwiftUI
import TraeDownloaderCore

struct TaskDetailAction: Identifiable {
    let id: String
    let title: String
    let role: ButtonRole?
    let handler: () -> Void

    init(_ title: String, role: ButtonRole? = nil, handler: @escaping () -> Void) {
        self.id = title
        self.title = title
        self.role = role
        self.handler = handler
    }
}

struct TaskDetailPane: View {
    let task: DownloadTask?
    let emptyTitle: String
    let emptyMessage: String
    let actions: [TaskDetailAction]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("任务详情")
                .font(.title2.weight(.semibold))

            Divider()

            if let task {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(for: task)
                        infoSection(for: task)
                        statusSection(for: task)
                        timestampSection(for: task)
                        if !task.errorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            errorSection(for: task)
                        }
                        actionSection
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 2)
                }
            } else {
                emptyState
            }
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.secondary.opacity(0.08))
        )
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(emptyTitle)
                .font(.headline)
            Text(emptyMessage)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 8)
    }

    private func header(for task: DownloadTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(task.displayTitle)
                .font(.title3.weight(.semibold))
                .lineLimit(3)

            HStack(spacing: 8) {
                pill(task.videoInfo.platform.displayName)
                pill(task.status.displayName)
                if task.progress > 0 {
                    pill(String(format: "%.1f%%", task.progress))
                }
            }

            Text(task.videoInfo.uploader.isEmpty ? "未知上传者" : task.videoInfo.uploader)
                .foregroundStyle(.secondary)
        }
    }

    private func infoSection(for task: DownloadTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("基础信息")
            detailRow("源链接", task.videoInfo.url)
            detailRow("下载路径", task.filePath.isEmpty ? "未写入" : task.filePath)
            if task.videoInfo.duration > 0 {
                detailRow("时长", formatDuration(task.videoInfo.duration))
            }
            if task.videoInfo.fileSize > 0 {
                detailRow("预估大小", formatByteCount(task.videoInfo.fileSize))
            }
        }
    }

    private func statusSection(for task: DownloadTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("状态")
            if task.status == .downloading || task.status == .paused || task.status == .pending {
                ProgressView(value: task.progress / 100.0)
                HStack(spacing: 12) {
                    detailValue("进度", String(format: "%.1f%%", task.progress))
                    detailValue("速度", task.speed)
                    detailValue("ETA", task.eta)
                    Spacer()
                }
            } else {
                detailRow("进度", String(format: "%.1f%%", task.progress))
                detailRow("速度", task.speed)
                detailRow("ETA", task.eta)
            }
        }
    }

    private func timestampSection(for task: DownloadTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("时间")
            detailRow("创建时间", formattedDate(task.createdAt))
            detailRow("开始时间", formattedDate(task.startedAt))
            detailRow("完成时间", formattedDate(task.completedAt))
        }
    }

    private func errorSection(for task: DownloadTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("错误")
            Text(task.errorMessage)
                .font(.callout)
                .foregroundStyle(.red)
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var actionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("操作")

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
                ForEach(actions) { action in
                    Button(action.title, role: action.role, action: action.handler)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.headline)
    }

    private func pill(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.thinMaterial, in: Capsule())
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 84, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func detailValue(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
        }
    }

    private func formattedDate(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func formatDuration(_ seconds: Int) -> String {
        guard seconds > 0 else { return "N/A" }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60
        if hours > 0 {
            return String(format: "%02d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%02d:%02d", minutes, secs)
    }

    private func formatByteCount(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
