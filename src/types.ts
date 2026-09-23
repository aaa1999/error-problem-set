export interface TextBlock {
  id: string;
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  /** 图片内容哈希，对应数据目录 assets/<hash>.<ext> */
  hash: string;
  ext: string;
}

export type Block = TextBlock | ImageBlock;

/** 文件夹，parentId 为 null 表示根层级，支持多层嵌套 */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface Mistake {
  id: string;
  /** 所属文件夹（可多个；空数组 = 未分类）。旧数据里的单个 folderId 加载时自动迁移 */
  folderIds: string[];
  /** 选择题选项（录入时选填）；空 = 非选择题，不参与选项作答与错误率 */
  options: string[];
  /** 正确选项在 options 里的下标；null = 未标记 */
  answer: number | null;
  /** 选项作答统计：错误率 = wrong / attempts（attempts 为 0 时视为 0%） */
  attempts: number;
  wrong: number;
  question: Block[];
  analysis: Block[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

/** 笔记：markdown 格式存源文本，word 格式存富文本 HTML；图片引用 assets/<hash>.<ext> */
export interface Note {
  id: string;
  title: string;
  format: "markdown" | "word";
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** 做题产生的「待导入清单」：手机上做完题存下来，随库同步到电脑，电脑按题号导入错题 */
export interface PendingImportEntry {
  /** 题号（1 起） */
  no: number;
  /** 我的答案（A–D，未作答 null） */
  mine: string | null;
  /** 正确答案（未对 null） */
  key: string | null;
  /** 做题时标记 ⭐ */
  flagged: boolean;
}

export interface PendingImport {
  id: string;
  folderName: string;
  createdAt: number;
  total: number;
  entries: PendingImportEntry[];
}

export interface Database {
  version: 3;
  mistakes: Mistake[];
  folders: Folder[];
  notes: Note[];
  /** 预建的独立标签：不挂在任何错题上也存在（侧栏新建），与错题自带的标签合并展示 */
  tags: string[];
  /** 待导入清单（做题 tab 产生，跨设备同步，按 id 去重） */
  pendingImports: PendingImport[];
}
