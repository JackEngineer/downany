import SwiftUI
import TraeDownloaderCore

struct SearchView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedURL: String?

    private var selectedResult: VideoInfo? {
        guard let selectedURL else { return nil }
        return model.searchResults.first { $0.url == selectedURL }
    }

    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 16) {
                searchBar
                recentSearchesStrip

                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(model.searchResults) { result in
                            SearchResultRow(
                                video: result,
                                isSelected: selectedURL == result.url,
                                onSelect: {
                                    selectedURL = result.url
                                },
                                onDownload: {
                                    Task { await model.enqueueDownload(videoInfo: result) }
                                },
                                onPreview: {
                                    selectedURL = result.url
                                    model.preview(videoInfo: result)
                                },
                                onOpen: {
                                    model.openSourceURL(result.url)
                                }
                            )
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .frame(minWidth: 680, idealWidth: 760)

            Divider()

            PreviewPaneView(video: selectedResult)
                .frame(minWidth: 360, idealWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
    }

    private var searchBar: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Picker("平台", selection: $model.selectedPlatform) {
                    ForEach([Platform.youtube, .bilibili, .pornhub], id: \.self) { platform in
                        Text(platform.displayName).tag(platform)
                    }
                }
                .frame(width: 180)

                TextField("输入搜索关键词", text: $model.searchQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        model.performSearch()
                    }

                Button("搜索") {
                    model.performSearch()
                }
                .keyboardShortcut(.return, modifiers: [.command])
            }

            HStack(spacing: 12) {
                Text(model.statusMessage)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("结果 \(model.searchResults.count)")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var recentSearchesStrip: some View {
        Group {
            if !model.recentSearches.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("最近搜索")
                            .font(.headline)
                        Spacer()
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.recentSearches) { entry in
                                Button {
                                    model.search(using: entry)
                                } label: {
                                    Text("\(entry.platform.displayName) · \(entry.query)")
                                        .lineLimit(1)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .padding(.horizontal, 4)
            }
        }
    }
}

private struct SearchResultRow: View {
    let video: VideoInfo
    let isSelected: Bool
    let onSelect: () -> Void
    let onDownload: () -> Void
    let onPreview: () -> Void
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                thumbnail

                VStack(alignment: .leading, spacing: 4) {
                    Text(video.displayTitle)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(video.uploader.isEmpty ? "未知上传者" : video.uploader)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(video.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 6) {
                    Text(video.platform.displayName)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.thinMaterial, in: Capsule())
                    Text(formatDuration(video.duration))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                Button("下载") { onDownload() }
                Button("预览") { onPreview() }
                Button("打开") { onOpen() }
                Spacer()
            }
            .buttonStyle(.borderless)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(isSelected ? Color.accentColor.opacity(0.8) : Color.secondary.opacity(0.12), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let url = URL(string: video.thumbnailURL), !video.thumbnailURL.isEmpty {
            AsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    placeholderThumb
                case .empty:
                    ProgressView()
                @unknown default:
                    placeholderThumb
                }
            }
            .frame(width: 84, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            placeholderThumb
        }
    }

    private var placeholderThumb: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.blue.opacity(0.12))
            .frame(width: 84, height: 48)
            .overlay(
                Text(video.platform.icon)
                    .font(.headline)
                    .foregroundStyle(.secondary)
            )
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
}
