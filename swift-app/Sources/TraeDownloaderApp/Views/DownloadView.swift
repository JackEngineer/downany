import SwiftUI
import TraeDownloaderCore

struct DownloadView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                section(title: "单条下载") {
                    HStack(spacing: 12) {
                        TextField("输入视频链接或 ID", text: $model.singleURLText)
                            .textFieldStyle(.roundedBorder)

                        Button("加入队列") {
                            Task { await model.enqueueSingleDownload() }
                        }
                        .keyboardShortcut(.return, modifiers: [.command])
                    }
                }

                section(title: "批量下载") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextEditor(text: $model.batchURLsText)
                            .frame(minHeight: 220)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(.quaternary, lineWidth: 1)
                            )

                        HStack {
                            Text("每行一个链接或 ID")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("批量加入队列") {
                                Task { await model.enqueueBatchDownloads() }
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title2.weight(.semibold))
            content()
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.secondary.opacity(0.08))
        )
    }
}
