import SwiftUI
import TraeDownloaderCore

@main
struct TraeDownloaderApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.settings)
                .frame(minWidth: 1280, minHeight: 820)
                .preferredColorScheme(colorScheme(for: model.settings.themeMode))
        }
    }

    private func colorScheme(for mode: ThemeMode) -> ColorScheme? {
        switch mode {
        case .system:
            return nil
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }
}
