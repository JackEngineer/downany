import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            SearchView()
                .tabItem {
                    Label("搜索", systemImage: "magnifyingglass")
                }

            DownloadView()
                .tabItem {
                    Label("下载", systemImage: "square.and.arrow.down")
                }

            QueueView()
                .tabItem {
                    Label("队列", systemImage: "tray.full")
                }

            HistoryView()
                .tabItem {
                    Label("历史", systemImage: "clock.arrow.circlepath")
                }

            SettingsView()
                .tabItem {
                    Label("设置", systemImage: "gearshape")
                }
        }
    }
}
