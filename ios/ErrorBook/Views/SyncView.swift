import SwiftUI

// MARK: - 同步（推送 / 按设备拉取）（对应桌面端 SyncDialog）
// 推送：整库增量上传到本设备在服务端的槽位；拉取：全部设备各自落盘到 devices/（不合并），侧栏按设备只读浏览。

private enum SyncMode: String, CaseIterable, Identifiable {
  case push = "推送"
  case pull = "按设备拉取"
  var id: String { rawValue }
}

struct SyncView: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss

  @State private var mode: SyncMode = .push
  @State private var addr = ""
  @State private var token = ""
  @State private var remember = false
  @State private var engine: SyncEngine?
  @State private var busy = false
  @State private var progress: SyncProgress?
  @State private var resultText = ""
  @State private var errorMessage = ""

  private var saved: SyncTarget? { SyncStore.load() }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("方向", selection: $mode) {
            ForEach(SyncMode.allCases) { m in
              Text("⬈ \(m.rawValue)").tag(m)
            }
          }
          .pickerStyle(.segmented)
          .onChange(of: mode) { _ in
            if !busy {
              errorMessage = ""
              resultText = ""
              progress = nil
            }
          }
        }

        Section("服务器") {
          TextField("例如 192.168.1.100:8080", text: $addr)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          SecureField("访问令牌（可选）", text: $token)
          Toggle("记住此地址", isOn: $remember)
        }

        if mode == .push {
          Section {
            Text("推送 \(store.db.mistakes.count) 道错题、\(store.db.notes.count) 篇笔记及引用的 \(collectLibraryAssets(store.db).count) 张图片。推送只覆盖本设备（\(DeviceIdentity.name())）在服务器上的版本，其他设备推送的数据不受影响。")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        } else {
          Section {
            Text("拉取服务器上全部设备各自推送的整库，每台设备单独保存到本机的 devices/ 目录，不与本机数据合并；之后在错题本里按 设备 → 文件夹 只读浏览、可复制。")
              .font(.footnote)
              .foregroundStyle(.secondary)
            if !store.remoteDevices.isEmpty {
              Text("本地已有 \(store.remoteDevices.count) 台设备的快照：\(store.remoteDevices.map { $0.name }.joined(separator: "、"))，重新拉取即刷新。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
          }
        }

        if busy, let p = progress {
          Section {
            ProgressView(value: Double(p.done + (p.phase == .data ? 1 : 0)), total: Double(max(p.total + 1, 1)))
            Text(phaseText(p)).font(.footnote).foregroundStyle(.secondary)
          }
        }
        if !errorMessage.isEmpty {
          Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
        }
        if !resultText.isEmpty {
          Section { Text(resultText).font(.footnote).foregroundStyle(.green) }
        }
      }
      .navigationTitle("☁ 同步")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(busy ? "隐藏" : "取消") { dismiss() }
            .disabled(false)
        }
        ToolbarItem(placement: .topBarTrailing) {
          if busy {
            Button("中止") { engine?.abort() }
          } else if resultText.isEmpty {
            Button(mode == .push ? "开始同步" : "拉取全部设备") { run() }
              .disabled(addr.trimmingCharacters(in: .whitespaces).isEmpty)
          } else {
            Button(mode == .push ? "再次同步" : "再次拉取") { run() }
          }
        }
      }
      .onAppear {
        if let s = saved {
          addr = s.server
          token = s.token ?? ""
          remember = true
        }
      }
    }
  }

  private func phaseText(_ p: SyncProgress) -> String {
    switch p.phase {
    case .connect:
      return mode == .push ? "正在连接服务器、获取清单…" : "正在连接服务器、获取设备清单…"
    case .devices:
      let cur = p.current.map { String($0.prefix(20)) } ?? ""
      return "正在拉取设备数据 \(min(p.done + 1, max(p.total, 1)))/\(p.total)（\(cur)…）"
    case .assets:
      let cur = p.current.map { String($0.prefix(16)) } ?? ""
      let label = mode == .push ? "上传" : "下载"
      return "正在\(label)图片 \(min(p.done + 1, max(p.total, 1)))/\(p.total)（\(cur)…）"
    case .data:
      return mode == .push ? "正在推送题库数据（data.json）…" : "拉取完成。"
    }
  }

  // ---------- 执行 ----------

  private func resolveTarget() -> SyncTarget? {
    guard let server = normalizeServerAddr(addr) else {
      errorMessage = "服务器地址无效。示例：192.168.1.100:8080（缺 http:// 前缀会自动补上）"
      return nil
    }
    addr = server
    return SyncTarget(server: server, token: token.trimmingCharacters(in: .whitespaces))
  }

  private func rememberTarget(_ t: SyncTarget) {
    if remember {
      SyncStore.save(t)
    } else {
      SyncStore.clear()
    }
  }

  private func run() {
    errorMessage = ""
    resultText = ""
    guard let target = resolveTarget() else { return }
    let engine = SyncEngine()
    self.engine = engine
    busy = true
    progress = nil
    Task { @MainActor in
      do {
        if mode == .push {
          let r = try await engine.push(target, db: store.db, dataDir: store.dataDir) { p in
            Task { @MainActor in progress = p }
          }
          rememberTarget(target)
          var parts = ["上传图片 \(r.uploadedAssets)/\(r.totalAssets) 张（其余服务器已有，跳过）"]
          if r.missingLocal > 0 { parts.append("\(r.missingLocal) 张本地文件缺失已跳过") }
          resultText = "同步完成：\(parts.joined(separator: "，"))；\(r.mistakes) 道错题、\(r.notes) 篇笔记、\(r.folders) 个文件夹已推送到本设备的版本。"
        } else {
          let r = try await engine.pullDevices(target, dataDir: store.dataDir) { p in
            Task { @MainActor in progress = p }
          }
          rememberTarget(target)
          store.reloadRemoteDevices()
          if r.onlySelf {
            resultText = "服务器上还没有其他设备的数据（本机自己的推送不会重复拉取）。"
          } else {
            let parts = r.pulled.map { "\($0.name)（\($0.mistakes) 题 / \($0.notes) 笔记）" }
            var extras: [String] = []
            if r.downloadedAssets > 0 { extras.append("下载图片 \(r.downloadedAssets) 张") }
            if r.missingAssets > 0 { extras.append("\(r.missingAssets) 张图片服务端缺失已跳过") }
            resultText = "拉取完成：\(r.pulled.count) 台设备已保存到本地（\(parts.joined(separator: "、"))）\(extras.isEmpty ? "" : "，\(extras.joined(separator: "，"))")。在错题本里按 设备 → 文件夹 浏览；本机数据未做任何改动。"
          }
        }
      } catch let e as SyncAborted {
        errorMessage = "已中止：重新同步会自动续上（已完成的保留）。"
      } catch {
        errorMessage = error.localizedDescription
      }
      busy = false
      progress = nil
    }
  }
}
