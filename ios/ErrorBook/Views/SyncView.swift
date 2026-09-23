import SwiftUI

// MARK: - 同步（推送 / 拉取）（对应桌面端 SyncDialog）
// 推送：整库增量上传；拉取：取远端整库 → 预览差量 → 幂等并入本地（不覆盖、不删除本地数据）。

private enum SyncMode: String, CaseIterable, Identifiable {
  case push = "推送"
  case pull = "拉取"
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
  // 拉取两步走：先取远端库算差量给用户确认，再执行合并
  @State private var pullPlan: MergePlan?

  private var saved: SyncTarget? { SyncStore.load() }

  private var pullNothingNew: Bool {
    guard let p = pullPlan else { return false }
    return p.newMistakes.isEmpty && p.newNotes.isEmpty && p.newTags.isEmpty && p.imageKeys.isEmpty
  }

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
              pullPlan = nil
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
            Text("推送 \(store.db.mistakes.count) 道错题、\(store.db.notes.count) 篇笔记及引用的 \(collectLibraryAssets(store.db).count) 张图片；服务器已有的图片自动跳过，可随时重复同步。")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        } else if let p = pullPlan {
          Section("拉取预览") {
            if pullNothingNew {
              Text("服务器数据已全部在本地，无需合并。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else {
              Text("服务器上有 \(p.source.mistakes.count) 道错题、\(p.source.notes.count) 篇笔记、\(p.source.folders.count) 个文件夹：将合并新增 \(p.newMistakes.count) 道错题、\(p.newNotes.count) 篇笔记、\(p.newTags.count) 个标签（含 \(p.imageCount) 张图片），其余本地已存在自动跳过。合并不会覆盖或删除本地任何数据。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
          }
        } else {
          Section {
            Text("拉取服务器上的整份题库并合并到本地：新增的错题/笔记/文件夹/标签并入，本地已有的自动跳过，缺的图片按内容哈希下载。换新设备恢复数据、或多端互相同步都用它，可随时重复执行。")
              .font(.footnote)
              .foregroundStyle(.secondary)
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
          } else if mode == .push {
            if resultText.isEmpty {
              Button("开始同步") { runPush() }
                .disabled(addr.trimmingCharacters(in: .whitespaces).isEmpty)
            } else {
              Button("再次同步") { runPush() }
            }
          } else {
            pullToolbarButton
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

  @ViewBuilder
  private var pullToolbarButton: some View {
    if let p = pullPlan {
      if pullNothingNew {
        Button("重新检查") { runPullCheck() }
      } else {
        Button("开始合并") { runPullMerge(p) }
      }
    } else if resultText.isEmpty {
      Button("检查并预览") { runPullCheck() }
        .disabled(addr.trimmingCharacters(in: .whitespaces).isEmpty)
    } else {
      Button("再次拉取") { runPullCheck() }
    }
  }

  private func phaseText(_ p: SyncProgress) -> String {
    switch p.phase {
    case .connect:
      return mode == .push ? "正在连接服务器、获取清单…" : "正在连接服务器、拉取题库数据…"
    case .assets:
      let cur = p.current.map { String($0.prefix(16)) } ?? ""
      let label = mode == .push ? "上传" : "下载"
      return "正在\(label)图片 \(min(p.done + 1, max(p.total, 1)))/\(p.total)（\(cur)…）"
    case .data:
      return mode == .push ? "正在推送题库数据（data.json）…" : "正在并入本地库…"
    }
  }

  // ---------- 推送 ----------

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

  private func runPush() {
    errorMessage = ""
    resultText = ""
    pullPlan = nil
    guard let target = resolveTarget() else { return }
    let engine = SyncEngine()
    self.engine = engine
    busy = true
    progress = nil
    Task { @MainActor in
      do {
        let r = try await engine.push(target, db: store.db, dataDir: store.dataDir) { p in
          Task { @MainActor in progress = p }
        }
        rememberTarget(target)
        var parts = ["上传图片 \(r.uploadedAssets)/\(r.totalAssets) 张（其余服务器已有，跳过）"]
        if r.missingLocal > 0 { parts.append("\(r.missingLocal) 张本地文件缺失已跳过") }
        resultText = "同步完成：\(parts.joined(separator: "，"))；\(r.mistakes) 道错题、\(r.notes) 篇笔记、\(r.folders) 个文件夹已推送。"
      } catch let e as SyncAborted {
        errorMessage = "已中止：本次已上传 \(e.uploaded) 张图片，重新同步会自动续传。"
      } catch {
        errorMessage = error.localizedDescription
      }
      busy = false
      progress = nil
    }
  }

  // ---------- 拉取 ----------

  private func runPullCheck() {
    errorMessage = ""
    resultText = ""
    pullPlan = nil
    guard let target = resolveTarget() else { return }
    let engine = SyncEngine()
    self.engine = engine
    busy = true
    progress = nil
    Task { @MainActor in
      do {
        pullPlan = try await engine.pullPlan(target, current: store.db) { p in
          Task { @MainActor in progress = p }
        }
      } catch {
        errorMessage = error.localizedDescription
      }
      busy = false
      progress = nil
    }
  }

  private func runPullMerge(_ plan: MergePlan) {
    errorMessage = ""
    guard let target = resolveTarget() else { return }
    let engine = SyncEngine()
    self.engine = engine
    busy = true
    progress = nil
    Task { @MainActor in
      do {
        let r = try await engine.pull(target, plan: plan, store: store) { p in
          Task { @MainActor in progress = p }
        }
        rememberTarget(target)
        resultText = "\(mergeOutcomeText(plan, r.outcome))本次下载图片 \(r.downloadedAssets) 张。"
        pullPlan = nil
      } catch let e as MergeAborted {
        errorMessage = "已中止：已下载 \(e.fetched) 张图片，重新拉取会自动续上。"
      } catch {
        errorMessage = error.localizedDescription
      }
      busy = false
      progress = nil
    }
  }
}
