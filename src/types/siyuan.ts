export interface SiYuanEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

export interface SiYuanNotebook {
  id: string;
  name: string;
  closed: boolean;
}

export interface SiYuanBlockRow {
  id: string;
  root_id: string;
  box: string;
  path: string;
  hpath: string;
  content: string;
  markdown: string;
  type: string;
  updated: string;
  title?: string;
}

export interface SiYuanOperation {
  action?: string;
  id?: string;
}

export interface SiYuanTransaction {
  doOperations?: SiYuanOperation[] | null;
}
