import SwiftUI

@main
struct ErrorBookApp: App {
  @StateObject private var store = BookStore()

  init() {
    NetworkPermissionProbe.start()
  }

  /// 截图/自动化验证用：launchArguments 传 -tab notes 可指定初始页
  @State private var tab: Tab = {
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "-tab"), i + 1 < args.count, let t = Tab(rawValue: args[i + 1]) {
      return t
    }
    return .book
  }()

  var body: some Scene {
    WindowGroup {
      TabView(selection: $tab) {
        BrowseTab()
          .tabItem { Label("错题本", systemImage: "book.fill") }
          .tag(Tab.book)
        NotesTab()
          .tabItem { Label("笔记", systemImage: "note.text") }
          .tag(Tab.notes)
        PracticeTab()
          .tabItem { Label("做题", systemImage: "pencil.and.list.clipboard") }
          .tag(Tab.practice)
        SettingsView()
          .tabItem { Label("设置", systemImage: "gearshape") }
          .tag(Tab.settings)
      }
      .environmentObject(store)
    }
  }
}

enum Tab: String {
  case book, notes, practice, settings
}
