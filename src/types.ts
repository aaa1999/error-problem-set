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
  folderId: string | null;
  question: Block[];
  analysis: Block[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Database {
  version: 2;
  mistakes: Mistake[];
  folders: Folder[];
}
