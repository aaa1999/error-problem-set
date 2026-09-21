export function NotesView() {
  return (
    <div className="empty-state">
      <div className="empty-icon">📝</div>
      <h2>笔记</h2>
      <p>笔记功能规划中，具体形态待定。</p>
      <div className="notes-ideas">
        <div className="notes-ideas-title">几个和现有架构契合的候选方向（定好后告诉我来实现）：</div>
        <ul>
          <li>
            <b>随手记</b>：图片 + 文字混排的自由笔记，复用现有编辑器和五通道图片导入，按文件夹归类
          </li>
          <li>
            <b>Markdown 笔记</b>：纯文字为主，支持标题/列表/公式的结构化笔记，与错题共用文件夹树
          </li>
          <li>
            <b>错题批注</b>：笔记挂在某道错题上，浏览/复习该题时在旁边展开，适合记录解题心得
          </li>
        </ul>
      </div>
    </div>
  );
}
