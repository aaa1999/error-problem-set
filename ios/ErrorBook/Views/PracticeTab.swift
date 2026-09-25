import SwiftUI

// MARK: - 做题 tab（对应桌面端 src/views/PracticeView.tsx）
// 外部刷题的答题卡：输文件夹名 + 题数（1–100）→ 逐题选 A/B/C/D 作答（可标记 ⭐ 值得导入）
// → 做完手动输入正确答案比对 → 答错的和标记过的一键导入错题本（所选文件夹，题干占位待补）。

struct PracticeTab: View {
  @EnvironmentObject private var store: BookStore

  /// 做题文件夹：@AppStorage 跨启动记住上次用的
  @AppStorage("practiceFolderName") private var folderName = ""
  @State private var countText = "100"
  // 会话保存在 tab 里：中途退出全屏页也能继续
  @State private var sheet: PracticeSheet?
  @State private var coverOpen = false

  var body: some View {
    NavigationStack {
      SetupForm(
        folderName: $folderName,
        countText: $countText,
        folderNames: Array(Set(store.db.folders.map { $0.name })).sorted(),
        hasSession: sheet != nil,
        onContinue: { coverOpen = true },
        onStart: start
      )
      .navigationTitle("✍️ 做题")
      .navigationBarTitleDisplayMode(.inline)
      .fullScreenCover(isPresented: $coverOpen) {
        if let s = sheet {
          PracticePhaseView(sheet: s) { updated in
            sheet = updated
          } onFinish: {
            sheet = nil
          }
        }
      }
    }
  }

  private var count: Int {
    min(100, max(1, Int(countText.trimmingCharacters(in: .whitespaces)) ?? 1))
  }

  private func start() {
    let n = count
    countText = "\(n)"
    sheet = PracticeSheet(
      folderName: folderName.trimmingCharacters(in: .whitespacesAndNewlines),
      count: n,
      mine: Array(repeating: nil, count: n),
      key: Array(repeating: nil, count: n),
      flagged: Array(repeating: false, count: n),
      imported: Array(repeating: false, count: n),
      importSel: Array(repeating: false, count: n)
    )
    coverOpen = true
  }
}

// MARK: - 阶段与 会话数据

/// 做题阶段：作答 → 对答案 → 结果（只存在视图本地 state，不随会话持久化）
enum PracticePhase {
  case answer, key, result
}

struct PracticeSheet {
  var folderName: String
  var count: Int
  var mine: [String?]   // 我的答案（"A"–"D"，未答 nil）
  var key: [String?]    // 正确答案（未对 nil）
  var flagged: [Bool]   // 做题过程中标记 ⭐ 值得导入
  var imported: [Bool]  // 已导入错题本
  var importSel: [Bool] // 结果页的导入勾选（进入结果时按「答错 ∪ 标记⭐」预勾，可增减）

  func verdict(_ i: Int) -> String {
    if key[i] == nil { return "unknown" }
    if mine[i] == nil { return "blank" }
    return mine[i] == key[i] ? "correct" : "wrong"
  }

  var stats: (correct: Int, wrong: Int, blank: Int, unknown: Int) {
    let v = (0..<count).map { verdict($0) }
    return (
      v.filter { $0 == "correct" }.count,
      v.filter { $0 == "wrong" }.count,
      v.filter { $0 == "blank" }.count,
      v.filter { $0 == "unknown" }.count
    )
  }

  /// 建议导入 = 答错 ∪ 标记 ⭐
  var suggest: [Int] {
    (0..<count).filter { verdict($0) == "wrong" || flagged[$0] }
  }
}

// MARK: - 设置页

private struct SetupForm: View {
  @Binding var folderName: String
  @Binding var countText: String
  let folderNames: [String]
  let hasSession: Bool
  let onContinue: () -> Void
  let onStart: () -> Void

  var body: some View {
    Form {
      if hasSession {
        Section {
          Button("继续上次做题", action: onContinue)
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity)
        }
      }
      Section {
        TextField("例如：数学 / 三角函数（留空 = 未分类）", text: $folderName)
        if !folderNames.isEmpty {
          Picker("选已有文件夹", selection: $folderName) {
            Text("（手输新名称）").tag("")
            ForEach(folderNames, id: \.self) { n in
              Text(n).tag(n)
            }
          }
        }
      } header: {
        Text("文件夹名")
      }
      Section {
        HStack {
          TextField("题数", text: $countText)
            .keyboardType(.numberPad)
          ForEach([10, 20, 50, 100], id: \.self) { n in
            Button("\(n)") { countText = "\(n)" }
              .buttonStyle(.bordered)
          }
        }
      } header: {
        Text("题数（1–100）")
      }
      Section {
        Button(hasSession ? "重新开始一组" : "开始做题", action: onStart)
          .buttonStyle(.borderedProminent)
          .frame(maxWidth: .infinity)
      }
    }
  }
}

// MARK: - 阶段页（作答 → 对答案 → 结果）

struct PracticePhaseView: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss
  let sheet: PracticeSheet
  let onUpdate: (PracticeSheet) -> Void
  let onFinish: () -> Void

  @State private var phase: PracticePhase = .answer
  private let opts = ["A", "B", "C", "D"]

  init(sheet: PracticeSheet, onUpdate: @escaping (PracticeSheet) -> Void, onFinish: @escaping () -> Void) {
    self.sheet = sheet
    self.onUpdate = onUpdate
    self.onFinish = onFinish
    _phase = State(initialValue: .answer)
  }

  var body: some View {
    NavigationStack {
      Group {
        switch phase {
        case .answer: answerList
        case .key: keyList
        case .result: resultList
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("退出") { dismiss() } // 会话保留，可从设置页继续
        }
        ToolbarItem(placement: .topBarTrailing) { trailing }
      }
    }
  }

  private var title: String {
    switch phase {
    case .answer: "做题中\(sheet.folderName.isEmpty ? "" : " · \(sheet.folderName)")"
    case .key: "对答案"
    case .result: "比对结果"
    }
  }

  @ViewBuilder
  private var trailing: some View {
    switch phase {
    case .answer:
      Button("完成作答 →") {
        onUpdate(sheet)
        phase = .key
      }
    case .key:
      Button("← 返回作答") { phase = .answer }
    case .result:
      EmptyView()
    }
  }

  // 作答页的右上主按钮放列表顶部，避免与「← 返回作答」挤在一起
  private var answerFooterButton: some View {
    Button("完成作答，去对答案 →") {
      onUpdate(sheet)
      phase = .key
    }
    .buttonStyle(.borderedProminent)
  }

  // ---------- 作答 ----------

  private var answerList: some View {
    List {
      Section {
        answerFooterButton
        Text("已答 \(sheet.mine.compactMap { $0 }.count) / \(sheet.count) 题；⭐ = 值得导入错题本")
          .font(.footnote).foregroundStyle(.secondary)
      }
      ForEach(0..<sheet.count, id: \.self) { i in
        HStack(spacing: 12) {
          Text("\(i + 1)").frame(width: 34).font(.subheadline.bold()).foregroundStyle(.secondary)
          optRow(value: sheet.mine[i]) { o in
            var s = sheet
            s.mine[i] = sheet.mine[i] == o ? nil : o
            onUpdate(s)
          }
          Spacer()
          Button {
            var s = sheet
            s.flagged[i].toggle()
            onUpdate(s)
          } label: {
            Image(systemName: sheet.flagged[i] ? "star.fill" : "star")
              .foregroundStyle(sheet.flagged[i] ? .yellow : .secondary)
          }
          .buttonStyle(.plain)
        }
        .listRowSeparator(.hidden)
      }
    }
    .listStyle(.plain)
  }

  // ---------- 对答案 ----------

  @State private var keyBulk = ""
  @State private var keyBulkMsg = ""

  /// 批量导入正确答案：每行「题号 分隔符 答案」（分隔符兼容若干空格/Tab/全角空格/逗号/顿号/句点/冒号；答案不分大小写，全角 ａ/Ａ/１ 先转半角），如「1  A」
  private func importKeyBulk() {
    var s = sheet
    var applied = 0
    var bad = 0
    // 按 isNewline 分行：\r\n 在 Swift 里是一个字符，用 == "\n" 判不开（CRLF 粘贴会整段挤成一行）
    for raw in keyBulk.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty { continue }
      // 形如 1<Tab>A / 1 A / 1,A
      guard let m = firstIntAndLetter(line), (1...s.count).contains(m.n),
            "ABCD".contains(m.o) else {
        bad += 1
        continue
      }
      s.key[m.n - 1] = m.o
      applied += 1
    }
    onUpdate(s)
    keyBulkMsg = "已填入 \(applied) 条" + (bad > 0 ? "，跳过无效行 \(bad) 行" : "")
    keyBulk = ""
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      keyBulkMsg = ""
    }
  }

  /// 从「12	A」这样的行里取题号与大写字母
  private func firstIntAndLetter(_ line: String) -> (n: Int, o: String)? {
    var nText = ""
    var rest = Substring(halfWidth(line))
    while let f = rest.first, f.isNumber {
      nText.append(f)
      rest = rest.dropFirst()
    }
    guard let n = Int(nText), n > 0 else { return nil }
    // 跳过分隔符（任意空白（含全角空格）/中英文逗号/顿号/句点/中英文冒号）
    while let f = rest.first, f.isWhitespace || f == "," || f == "，" || f == "、" || f == "." || f == ":" || f == "：" {
      rest = rest.dropFirst()
    }
    guard let o = rest.first, "ABCDabcd".contains(o) else { return nil }
    return (n, String(o).uppercased())
  }

  /// 全角字母/数字（！–～）转半角：中文输入法打出的 ａ/Ａ/１ 也能解析
  private func halfWidth(_ line: String) -> String {
    String(String.UnicodeScalarView(line.unicodeScalars.map {
      (0xFF01...0xFF5E).contains($0.value) ? UnicodeScalar($0.value - 0xFEE0)! : $0
    }))
  }

  private var keyList: some View {
    List {
      Section {
        Button("完成比对 →") {
          var s = sheet
          // 进入结果页时预勾「答错 ∪ 标记⭐」，之后由用户自行增减
          s.importSel = (0..<s.count).map { s.verdict($0) == "wrong" || s.flagged[$0] }
          onUpdate(s)
          phase = .result
        }
        .buttonStyle(.borderedProminent)
        Text("逐题输入正确答案；已对 \(sheet.key.compactMap { $0 }.count) / \(sheet.count) 题，没对的按「未比对」处理")
          .font(.footnote).foregroundStyle(.secondary)
      }
      Section("批量导入正确答案（每行：题号 + 空格或 Tab + 答案，不分大小写）") {
        TextEditor(text: $keyBulk)
          .font(.body.monospaced())
          .frame(minHeight: 88)
          .overlay(alignment: .topLeading) {
            if keyBulk.isEmpty {
              Text("1 A\n2 C\n3 B").font(.body.monospaced()).foregroundStyle(.tertiary)
                .padding(.top, 8).padding(.leading, 4).allowsHitTesting(false)
            }
          }
        Button("从文本填入") { importKeyBulk() }
          .disabled(keyBulk.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        if !keyBulkMsg.isEmpty {
          Text(keyBulkMsg).font(.footnote).foregroundStyle(.secondary)
        }
      }
      ForEach(0..<sheet.count, id: \.self) { i in
        HStack(spacing: 12) {
          Text("\(i + 1)").frame(width: 34).font(.subheadline.bold()).foregroundStyle(.secondary)
          optRow(value: sheet.key[i]) { o in
            var s = sheet
            s.key[i] = o
            onUpdate(s)
          }
          Spacer()
          if let m = sheet.mine[i] {
            Text("我选 \(m)")
              .font(.caption)
              .foregroundStyle(m == sheet.key[i] ? .green : (sheet.key[i] == nil ? .secondary : .red))
          } else {
            Text("未答").font(.caption).foregroundStyle(.tertiary)
          }
        }
        .listRowSeparator(.hidden)
      }
    }
    .listStyle(.plain)
  }

  // ---------- 结果 ----------

  private var resultList: some View {
    List {
      let st = sheet.stats
      Section {
        HStack(spacing: 14) {
          Label("\(st.correct)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
          Label("\(st.wrong)", systemImage: "xmark.circle.fill").foregroundStyle(.red)
          Text("未答 \(st.blank) · 未比对 \(st.unknown)").font(.footnote).foregroundStyle(.secondary)
          if st.correct + st.wrong > 0 {
            Text("正确率 \(Int(Double(st.correct) / Double(st.correct + st.wrong) * 100))%")
              .font(.footnote.bold()).foregroundStyle(.blue)
          }
        }
        let checked = (0..<sheet.count).filter { sheet.importSel[$0] && !sheet.imported[$0] }
        if !checked.isEmpty {
          Button("导入勾选的 \(checked.count) 题") {
            var s = sheet
            for i in checked {
              importOne(i, into: &s)
            }
            onUpdate(s)
          }
          .buttonStyle(.borderedProminent)
        }
        Button("存为待导入清单（推送后在电脑导入）") {
          var s = sheet
          let checked = (0..<s.count).filter { s.importSel[$0] && !s.imported[$0] }
          guard !checked.isEmpty else { return }
          store.addPendingImport(
            PendingImport(
              folderName: s.folderName,
              createdAt: Date().nowMs,
              total: s.count,
              entries: checked.map { i in
                PendingImportEntry(no: i + 1, mine: s.mine[i], key: s.key[i], flagged: s.flagged[i])
              }
            )
          )
          onFinish()
          dismiss()
        }
        .buttonStyle(.borderedProminent)
        Button("再来一组（结束本次）") {
          onFinish()
          dismiss()
        }
        .buttonStyle(.bordered)
      }

      Section("是否导入错题本（答错 / 标记 ⭐ 默认勾选，可自行调整）") {
        if sheet.suggest.isEmpty {
          Text("没有候选题——全对且没有标记 ⭐ 👏").font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(sheet.suggest, id: \.self) { i in
          HStack {
            Button {
              var s = sheet
              s.importSel[i].toggle()
              onUpdate(s)
            } label: {
              Image(systemName: sheet.imported[i] || sheet.importSel[i] ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(sheet.imported[i] ? .green : Color.accentColor)
            }
            .buttonStyle(.plain)
            .disabled(sheet.imported[i])
            Text("\(i + 1)").frame(width: 30).font(.subheadline.bold()).foregroundStyle(.secondary)
            Text(verdictText(i)).font(.subheadline)
            Spacer()
            if sheet.imported[i] {
              Label("已导入", systemImage: "checkmark").font(.caption).foregroundStyle(.green)
            }
          }
        }
      }

      Section("全部题目") {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
          ForEach(0..<sheet.count, id: \.self) { i in
            let v = sheet.verdict(i)
            Text("\(i + 1)")
              .font(.caption.bold())
              .frame(maxWidth: .infinity, minHeight: 26)
              .background(RoundedRectangle(cornerRadius: 7).fill(practiceCellBg(v)))
              .foregroundStyle(practiceCellFg(v))
              .overlay(alignment: .topTrailing) {
                if sheet.imported[i] {
                  Image(systemName: "checkmark.circle.fill").font(.system(size: 9)).foregroundStyle(Color.accentColor)
                    .offset(x: 3, y: -3)
                } else if sheet.flagged[i] && v != "wrong" {
                  Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(.yellow)
                    .offset(x: 3, y: -3)
                }
              }
          }
        }
        .padding(.vertical, 4)
      }
    }
  }

  // ---------- 小部件 ----------

  @ViewBuilder
  private func optRow(value: String?, onPick: @escaping (String) -> Void) -> some View {
    HStack(spacing: 5) {
      ForEach(opts, id: \.self) { o in
        Button {
          onPick(o)
        } label: {
          Text(o)
            .font(.subheadline.bold())
            .frame(width: 32, height: 28)
            .background(
              RoundedRectangle(cornerRadius: 7).fill(value == o ? Color.accentColor : Color(.systemGray6))
            )
            .foregroundStyle(value == o ? .white : .secondary)
        }
        .buttonStyle(.plain)
      }
    }
  }

  private func verdictText(_ i: Int) -> String {
    switch sheet.verdict(i) {
    case "wrong": "我选 \(sheet.mine[i] ?? "—") ✕ · 正确 \(sheet.key[i] ?? "—")"
    case "blank": "未作答 · 正确 \(sheet.key[i] ?? "—")"
    default: "答对 ✓\(sheet.flagged[i] ? " · 标记 ⭐" : "")"
    }
  }

  /// 导入一题：在会话文件夹里生成占位条目（题干待补），批改记录写进解析
  private func importOne(_ i: Int, into s: inout PracticeSheet) {
    let folder = s.folderName.isEmpty ? nil : store.findOrCreateFolderPath(s.folderName, baseParentId: nil)
    let record: String
    switch s.verdict(i) {
    case "wrong": record = "我选 \(s.mine[i] ?? "未作答")，正确答案 \(s.key[i] ?? "未对")"
    case "blank": record = "未作答，正确答案 \(s.key[i] ?? "未对")"
    default: record = "答对（标记 ⭐ 导入）"
    }
    store.addMistake(
      Mistake(
        folderIds: folder.map { [$0.id] } ?? [],
        options: [],
        answer: nil,
        attempts: 0,
        wrong: 0,
        question: [.text(id: UUID().uuidString.lowercased(), text: "第 \(i + 1) 题（做题导入，待补充题目内容）")],
        analysis: [.text(id: UUID().uuidString.lowercased(), text: "做题批改（\(formatTime(Date().nowMs))）：\(record)。")],
        tags: []
      )
    )
    s.imported[i] = true
  }
}


/// 结果网格单元格配色（拆成小函数避免超长三元表达式拖垮类型检查）
func practiceCellBg(_ v: String) -> Color {
  if v == "correct" { return Color.green.opacity(0.15) }
  if v == "wrong" { return Color.red.opacity(0.15) }
  return Color(UIColor.systemGray6)
}

func practiceCellFg(_ v: String) -> Color {
  if v == "correct" { return .green }
  if v == "wrong" { return .red }
  return .secondary
}
