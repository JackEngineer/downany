import SwiftUI
import TraeDownloaderCore

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        Form {
            Section("下载目录") {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("下载目录", text: $settings.downloadDirectory)

                    HStack {
                        Text(settings.downloadDirectory)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                        Button("打开下载目录") {
                            model.openDownloadDirectory()
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }

            Section("并发与限速") {
                Stepper(value: $settings.concurrentDownloads, in: 1...10) {
                    Text("并发下载数: \(settings.concurrentDownloads)")
                }
                Stepper(
                    value: Binding(
                        get: { settings.speedLimit / 1024 },
                        set: { settings.speedLimit = max(0, $0) * 1024 }
                    ),
                    in: 0...100_000,
                    step: 128
                ) {
                    Text(
                        "速度限制: \(settings.speedLimit == 0 ? "无限制" : "\(settings.speedLimit / 1024) KB/s")"
                    )
                }
            }

            Section("代理") {
                Toggle("启用代理", isOn: $settings.proxyEnabled)
                TextField("代理地址", text: $settings.proxyURL)
            }

            Section("默认下载参数") {
                Picker("默认质量", selection: $settings.defaultQuality) {
                    ForEach(DownloadQuality.allCases) { quality in
                        Text(quality.displayName).tag(quality)
                    }
                }

                Toggle("下载字幕", isOn: $settings.downloadSubtitles)
            }

            Section("外观") {
                Picker("主题", selection: $settings.themeMode) {
                    ForEach(ThemeMode.allCases) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
            }
        }
        .padding(20)
    }
}
