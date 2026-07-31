import AVKit
import SwiftUI
import TraeDownloaderCore

struct PreviewPaneView: View {
    @EnvironmentObject private var model: AppModel
    let video: VideoInfo?

    private var player: AVPlayer? {
        model.previewPlayer
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("预览")
                .font(.title2.weight(.semibold))

            if let video {
                VStack(alignment: .leading, spacing: 6) {
                    Text(video.displayTitle)
                        .font(.headline)
                        .lineLimit(2)
                    Text(video.uploader.isEmpty ? "未知上传者" : video.uploader)
                        .foregroundStyle(.secondary)
                    Text(video.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            } else {
                Text("请选择一个搜索结果。")
                    .foregroundStyle(.secondary)
            }

            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.secondary.opacity(0.08))

                if let player {
                    AppKitPlayerView(player: player)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "play.rectangle")
                            .font(.system(size: 42))
                            .foregroundStyle(.secondary)
                        Text(model.previewMessage)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                }
            }
            .frame(minHeight: 260)

            HStack {
                Text(model.previewMessage)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("清空") {
                    model.clearPreview()
                }
            }
        }
        .padding(.leading, 8)
    }
}

private struct AppKitPlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let playerView = AVPlayerView()
        playerView.controlsStyle = .floating
        playerView.videoGravity = .resizeAspect
        playerView.player = player
        return playerView
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player !== player {
            nsView.player = player
        }
    }
}
