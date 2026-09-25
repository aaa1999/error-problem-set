package com.errorbook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// 核心逻辑移植验证：与桌面端 / iOS 端同口径的纯函数层。
// 运行：./gradlew testDebugUnitTest

class ModelsTest {

    @Test
    fun decode_desktop_data_json_with_legacy_fields() {
        // 旧格式：单个 folderId、缺 options/attempts/wrong/tags 字段、folderId 缺失
        val json = """
        {
          "version": 3,
          "mistakes": [
            {
              "id": "aaa",
              "folderId": "f1",
              "question": [{"type":"text","id":"t1","text":"题干"},{"type":"image","hash":"abc","ext":"png"}],
              "analysis": [],
              "createdAt": 1000,
              "updatedAt": 2000
            },
            {
              "id": "bbb",
              "folderIds": ["f1","f2"],
              "options": ["A 选项","B 选项"],
              "answer": 1,
              "attempts": 3,
              "wrong": 1,
              "question": [],
              "analysis": [],
              "tags": ["数学"],
              "createdAt": 3000,
              "updatedAt": 4000
            }
          ],
          "folders": [
            {"id":"f1","name":"数学","parentId":null,"createdAt":1},
            {"id":"f2","name":"几何","parentId":"f1","createdAt":2}
          ],
          "notes": [],
          "tags": ["预建标签"],
          "pendingImports": [
            {"id":"p1","folderName":"卷子","createdAt":9,"total":2,
             "entries":[{"no":1,"mine":"A","key":"B","flagged":true},{"no":2}]}
          ]
        }
        """.trimIndent()
        val db = BookStore.json.decodeFromString(DatabaseSerializer, json)
        assertEquals(2, db.mistakes.size)
        // 旧单值 folderId 迁移为 [f1]
        assertEquals(listOf("f1"), db.mistakes[0].folderIds)
        assertEquals(0, db.mistakes[0].attempts)
        assertNull(db.mistakes[0].answer)
        // 图片块无 id、文字块带 id
        assertEquals(Block.Text("t1", "题干"), db.mistakes[0].question[0])
        assertEquals(Block.Image("abc", "png"), db.mistakes[0].question[1])
        // 新格式多文件夹 + 选择题统计
        assertEquals(listOf("f1", "f2"), db.mistakes[1].folderIds)
        assertEquals(1, db.mistakes[1].answer)
        assertEquals(3, db.mistakes[1].attempts)
        assertEquals(1, db.mistakes[1].wrong)
        assertEquals(listOf("预建标签"), db.tags)
        assertEquals(2, db.pendingImports[0].entries.size)
        assertTrue(db.pendingImports[0].entries[0].flagged)
        assertNull(db.pendingImports[0].entries[1].mine)
        // 文件夹
        assertEquals("数学", db.folders[0].name)
        assertNull(db.folders[0].parentId)
    }

    @Test
    fun encode_decode_round_trip_keeps_schema() {
        val m = Mistake(
            id = "x",
            folderIds = listOf("a", "b"),
            options = listOf("1", "2"),
            answer = 0,
            attempts = 5,
            wrong = 2,
            question = listOf(Block.Text("t", "q"), Block.Image("h", "jpg")),
            analysis = emptyList(),
            tags = listOf("T"),
            createdAt = 1.0,
            updatedAt = 2.0,
        )
        val db = Database(mistakes = listOf(m), folders = listOf(Folder("a", "F", null, 1.0)), notes = listOf(Note("n", "标题", NoteFormat.MARKDOWN, "内容", 1.0, 2.0)), tags = listOf("Z"))
        val out = BookStore.json.encodeToString(DatabaseSerializer, db)
        // 顶层字段与桌面端一致
        assertTrue(out.contains("\"version\""))
        assertTrue(out.contains("\"folderIds\""))
        assertFalse(out.contains("\"folderId\"")) // 保存只写新格式
        val back = BookStore.json.decodeFromString(DatabaseSerializer, out)
        assertEquals(db, back)
    }

    @Test
    fun tolerant_decode_of_broken_fields() {
        // 非法类型 / null / 缺顶层键：全部回退默认值，不抛异常（与 iOS try? decode 同口径）
        val db = BookStore.json.decodeFromString(
            DatabaseSerializer,
            """{"mistakes":[{"id":"m","folderIds":null,"attempts":null,"question":"bad","answer":null}],"version":"x"}""",
        )
        assertEquals(1, db.mistakes.size)
        assertEquals(emptyList<String>(), db.mistakes[0].folderIds)
        assertEquals(0, db.mistakes[0].attempts)
        assertEquals(emptyList<Block>(), db.mistakes[0].question)
        assertEquals(3, db.version)
    }

    @Test
    fun save_and_load_db_via_temp_dir() {
        val dir = kotlin.io.path.createTempDirectory("ebtest").toFile()
        try {
            val db = Database(mistakes = listOf(Mistake(id = "m1", question = listOf(Block.Text("t", "hello")))))
            BookStore.saveDb(db, dir)
            val loaded = BookStore.loadDb(dir)
            assertEquals("m1", loaded.mistakes[0].id)
            assertEquals("hello", (loaded.mistakes[0].question[0] as Block.Text).text)
            // 原子写不留 tmp
            assertFalse(File(dir, "data.json.tmp").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun seeded_shuffle_stable_per_seed() {
        val base = (1..50).map { it }
        val a = seededShuffle(base, 123)
        val b = seededShuffle(base, 123)
        assertEquals(a, b)
        assertEquals(base.toSet(), a.toSet())
        val c = seededShuffle(base, 456)
        assertFalse(a == c)
    }

    @Test
    fun option_rate() {
        assertEquals(0, optionRate(Mistake(attempts = 0, wrong = 0)))
        assertEquals(67, optionRate(Mistake(attempts = 3, wrong = 2)))
        assertEquals(50, optionRate(Mistake(attempts = 2, wrong = 1)))
    }

    @Test
    fun blocks_empty_and_plain_text() {
        assertTrue(isBlocksEmpty(listOf(Block.Text("t", "  "), Block.Text("t2", "\n"))))
        assertTrue(isBlocksEmpty(emptyList()))
        assertFalse(isBlocksEmpty(listOf(Block.Text("t", "x"))))
        assertFalse(isBlocksEmpty(listOf(Block.Image("h", "png"))))
        assertEquals("a\n[图]\nb", blocksToPlainText(listOf(Block.Text("t", "a"), Block.Image("h", "png"), Block.Text("t2", "b"))))
    }
}

class FoldersTest {

    private val folders = listOf(
        Folder("root1", "数学", null, 1.0),
        Folder("root2", "英语", null, 2.0),
        Folder("sub1", "几何", "root1", 3.0),
        Folder("sub2", "立体几何", "sub1", 4.0),
    )

    @Test
    fun path_name_and_descendants() {
        assertEquals("未分类", folderPathName(folders, null))
        assertEquals("未分类", folderPathName(folders, "missing"))
        assertEquals("数学 / 几何 / 立体几何", folderPathName(folders, "sub2"))
        assertEquals(setOf("root1", "sub1", "sub2"), descendantSet(folders, "root1"))
    }

    @Test
    fun folder_counts_with_multi_membership() {
        val mistakes = listOf(
            Mistake(id = "m1", folderIds = listOf("root1")),
            Mistake(id = "m2", folderIds = listOf("sub2")),
            Mistake(id = "m3", folderIds = listOf("root1", "root2")), // 多归属在两个文件夹都计数
            Mistake(id = "m4", folderIds = emptyList()),
            Mistake(id = "m5", folderIds = listOf("gone")), // 指向已删除文件夹 → 未分类
        )
        assertEquals(3, countInFolder(mistakes, folders, "root1"))
        assertEquals(1, countInFolder(mistakes, folders, "sub2"))
        assertEquals(2, countUncategorized(mistakes, folders))
    }

    @Test
    fun flat_order_is_depth_first() {
        val flat = flatFolders(folders)
        assertEquals(listOf("root1", "sub1", "sub2", "root2"), flat.map { it.folder.id })
        assertEquals(listOf(0, 1, 2, 0), flat.map { it.depth })
    }

    @Test
    fun natural_sort_numbers() {
        assertTrue(naturalLess("题2", "题10"))
        assertFalse(naturalLess("题10", "题2"))
        assertTrue(naturalLess("img_9.png", "img_10.png"))
        assertFalse(naturalLess("a", "a"))
        assertTrue(naturalLess("abc", "abcd"))
    }
}

class MarkdownTest {

    @Test
    fun headings_hr_and_breaks() {
        val html = Markdown.render("# 标题\n正文一\n正文二\n---\n尾行")
        assertTrue(html.contains("<h1>标题</h1>"))
        // 单个换行 → <br>（与桌面端 breaks 一致）
        assertTrue(html.contains("正文一<br>"))
        assertTrue(html.contains("<hr>"))
    }

    @Test
    fun bold_italic_code_and_link() {
        val html = Markdown.render("**粗** *斜* `code` [链](https://a.b) ~~删~~")
        assertTrue(html.contains("<strong>粗</strong>"))
        assertTrue(html.contains("<em>斜</em>"))
        assertTrue(html.contains("<code>code</code>"))
        assertTrue(html.contains("<a href=\"https://a.b\">链</a>"))
        assertTrue(html.contains("<del>删</del>"))
    }

    @Test
    fun list_task_list_and_quote() {
        val html = Markdown.render("- 甲\n- 乙\n\n> 引用一\n> 引用二\n\n- [ ] 待办\n- [x] 已办")
        assertTrue(html.contains("<ul>"))
        assertTrue(html.contains("<li>甲</li>"))
        assertTrue(html.contains("<blockquote>"))
        assertTrue(html.contains("checked"))
    }

    @Test
    fun fenced_code_and_table() {
        val html = Markdown.render("```\n<code> 块\n```\n\n| A | B |\n| --- |:---: |\n| 1 | 2 |")
        assertTrue(html.contains("<pre><code>&lt;code&gt; 块</code></pre>"))
        assertTrue(html.contains("<table><thead><tr><th>A</th>"))
        assertTrue(html.contains("text-align:center"))
    }

    @Test
    fun asset_refs_collected_and_mapped() {
        val md = "看 ![](assets/abc123.png) 和 <img src=\"assets/def456.jpg\">"
        assertEquals(listOf("assets/abc123.png", "assets/def456.jpg"), collectAssetRefs(md))
        val mapped = Markdown.render("![x](assets/abc123.png)") { ref -> "MAPPED:$ref" }
        assertTrue(mapped.contains("MAPPED:assets/abc123.png"))
    }

    @Test
    fun sanitize_strips_scripts() {
        val out = sanitizeLite("<p onclick=\"x()\">a</p><script>bad()</script><img src=\"javascript:alert(1)\">")
        assertFalse(out.contains("script"))
        assertFalse(out.contains("onclick"))
        assertFalse(out.contains("javascript:"))
    }

    @Test
    fun note_excerpt_and_empty() {
        val md = Note(content = "# 标\n正文摘" + "要".repeat(100))
        val ex = noteExcerpt(md)
        assertTrue(ex.length <= 81)
        assertFalse(ex.contains("#"))
        val word = Note(format = NoteFormat.WORD, content = "<b>粗</b><p>文</p>")
        assertEquals("粗 文", noteExcerpt(word))
        assertTrue(isNoteEmpty("", "  \n", NoteFormat.MARKDOWN))
        assertFalse(isNoteEmpty("", "![](assets/a.png)", NoteFormat.MARKDOWN))
        assertFalse(isNoteEmpty("有标题", "", NoteFormat.MARKDOWN))
        assertTrue(isNoteEmpty("", "<p> </p>", NoteFormat.WORD))
    }
}

class PracticeParseTest {

    @Test
    fun parse_number_and_letter_variants() {
        assertEquals(1 to "A", firstIntAndLetter("1 A"))
        assertEquals(12 to "C", firstIntAndLetter("12\tC"))
        assertEquals(3 to "D", firstIntAndLetter("3,D"))
        assertEquals(4 to "B", firstIntAndLetter("4.B"))
        assertEquals(null, firstIntAndLetter("4。B")) // 中文句点不在分隔符表里，与 iOS 端一致
        assertEquals(5 to "C", firstIntAndLetter("5：c")) // 中文冒号 + 小写
        assertEquals(6 to "A", firstIntAndLetter("６ ａ")) // 全角数字与字母
        assertEquals(7 to "B", firstIntAndLetter("7，B"))
        assertEquals(null, firstIntAndLetter("abc"))
        assertEquals(null, firstIntAndLetter("0 A"))
        assertEquals(null, firstIntAndLetter("1 E")) // 超出 ABCD
    }

    @Test
    fun half_width_conversion() {
        assertEquals("AB12", halfWidth("ＡＢ１２"))
        assertEquals("a\u3000b", halfWidth("ａ\u3000b")) // U+3000 不在 FF01-FF5E，保持原样（isWhitespace 兜底）
    }
}

class MergePlanTest {

    @Test
    fun plan_merge_counts_only_new() {
        val current = Database(
            mistakes = listOf(Mistake(id = "a", tags = listOf("数学"))),
            tags = listOf("已有标签"),
            pendingImports = listOf(PendingImport(id = "p0")),
        )
        val source = Database(
            mistakes = listOf(
                Mistake(id = "a", question = listOf(Block.Text("t", "dup"))),   // 重复 → 跳过
                Mistake(id = "b", tags = listOf("数学")),                        // 新增（标签已存在）
                Mistake(id = "c", tags = listOf("新标签")),                      // 新增
            ),
            notes = listOf(Note(id = "n1"), Note(id = "n2")),
            folders = listOf(Folder("f1", "数学", null, 1.0)),
            tags = listOf("已有标签", "全新标签", "新标签"), // 全新标签 1 个（新标签随错题带入，已有跳过）
            pendingImports = listOf(PendingImport(id = "p0"), PendingImport(id = "p1")),
        )
        val plan = planMerge(source, current)
        assertEquals(listOf("b", "c"), plan.newMistakes.map { it.id })
        assertEquals(1, plan.skipped)
        assertEquals(2, plan.newNotes.size)
        assertEquals(listOf("全新标签"), plan.newTags)
        assertEquals(listOf("p1"), plan.newPendingImports.map { it.id })
    }
}
