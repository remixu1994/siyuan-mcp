import { AppError } from "../errors/app-error.js";
import type {
  SiYuanBlockRow,
  SiYuanNotebook,
  SiYuanTransaction,
} from "../types/siyuan.js";
import { SiYuanClient } from "./siyuan-client.js";

export interface NotebookResult {
  id: string;
  name: string;
  closed: boolean;
}

export interface DocumentSummary {
  id: string;
  notebookId: string;
  title: string;
  path: string;
  updated: string;
}

export interface SearchResult {
  blockId: string;
  documentId: string;
  notebookId: string;
  title: string;
  path: string;
  snippet: string;
}

export class SiYuanNoteService {
  constructor(private readonly client: SiYuanClient) {}

  async listNotebooks(): Promise<{ notebooks: NotebookResult[] }> {
    const data = await this.client.post<{ notebooks: SiYuanNotebook[] }>(
      "/api/notebook/lsNotebooks",
      {},
      "read",
    );
    return {
      notebooks: data.notebooks.map(({ id, name, closed }) => ({ id, name, closed })),
    };
  }

  async listDocuments(notebookId: string, path: string): Promise<{ documents: DocumentSummary[] }> {
    await this.assertNotebookExists(notebookId);
    const normalizedPath = normalizePath(path);
    const prefix = normalizedPath === "/" ? "/" : `${normalizedPath}/`;
    const likePrefix = escapeLike(prefix);
    const statement = [
      "SELECT id, root_id, box, path, hpath, content, markdown, type, updated",
      "FROM blocks",
      `WHERE type = 'd' AND box = '${sqlLiteral(notebookId)}'`,
      `AND hpath LIKE '${likePrefix}%' ESCAPE '\\'`,
      `AND hpath NOT LIKE '${likePrefix}%/%' ESCAPE '\\'`,
      "ORDER BY sort ASC, hpath ASC LIMIT 200",
    ].join(" ");

    const rows = await this.query(statement);
    return {
      documents: rows.map((row) => ({
        id: row.id,
        notebookId: row.box,
        title: row.content || lastPathSegment(row.hpath),
        path: row.hpath,
        updated: row.updated,
      })),
    };
  }

  async searchNotes(
    query: string,
    limit: number,
    notebookId?: string,
  ): Promise<{ results: SearchResult[] }> {
    if (notebookId) await this.assertNotebookExists(notebookId);
    const needle = `%${escapeLike(query.trim())}%`;
    const notebookClause = notebookId ? ` AND b.box = '${sqlLiteral(notebookId)}'` : "";
    const statement = [
      "SELECT b.id, b.root_id, b.box, b.path, b.hpath, b.content, b.markdown, b.type, b.updated,",
      "COALESCE((SELECT r.content FROM blocks r WHERE r.id = b.root_id LIMIT 1), '') AS title",
      "FROM blocks b",
      `WHERE (b.content LIKE '${needle}' ESCAPE '\\' OR b.markdown LIKE '${needle}' ESCAPE '\\')`,
      notebookClause,
      `ORDER BY b.updated DESC LIMIT ${limit}`,
    ].join(" ");

    let rows: SiYuanBlockRow[];
    try {
      rows = await this.query(statement);
    } catch (error) {
      if (error instanceof AppError && error.code === "OPERATION_FAILED") {
        throw new AppError("SEARCH_UNAVAILABLE", "SiYuan search is unavailable.", 502, {
          cause: error,
        });
      }
      throw error;
    }

    return {
      results: rows.map((row) => ({
        blockId: row.id,
        documentId: row.root_id,
        notebookId: row.box,
        title: row.title || lastPathSegment(row.hpath),
        path: row.hpath,
        snippet: truncate(row.markdown || row.content, 500),
      })),
    };
  }

  async getDocument(documentId: string): Promise<{
    documentId: string;
    path: string;
    markdown: string;
  }> {
    await this.assertDocumentExists(documentId);
    const data = await this.client.post<{ hPath: string; content: string }>(
      "/api/export/exportMdContent",
      { id: documentId },
      "read",
    );
    return { documentId, path: data.hPath, markdown: data.content };
  }

  async createDocument(
    notebookId: string,
    path: string,
    markdown: string,
  ): Promise<{ documentId: string; path: string; created: true }> {
    await this.assertNotebookExists(notebookId);
    const normalizedPath = normalizePath(path);
    const existing = await this.client.post<string[]>(
      "/api/filetree/getIDsByHPath",
      { notebook: notebookId, path: normalizedPath },
      "read",
    );
    if (existing.length > 0) {
      throw new AppError(
        "DOCUMENT_ALREADY_EXISTS",
        "A SiYuan document already exists at the requested path.",
        409,
      );
    }

    const documentId = await this.client.post<string>(
      "/api/filetree/createDocWithMd",
      { notebook: notebookId, path: normalizedPath, markdown },
      "write",
    );
    return { documentId, path: normalizedPath, created: true };
  }

  async appendContent(
    documentId: string,
    markdown: string,
  ): Promise<{ documentId: string; appended: true; blockIds: string[] }> {
    await this.assertDocumentExists(documentId);
    const transactions = await this.client.post<SiYuanTransaction[]>(
      "/api/block/appendBlock",
      { dataType: "markdown", data: markdown, parentID: documentId },
      "write",
    );
    return {
      documentId,
      appended: true,
      blockIds: extractOperationIds(transactions),
    };
  }

  async updateBlock(blockId: string, markdown: string): Promise<{ blockId: string; updated: true }> {
    await this.assertBlockExists(blockId);
    await this.client.post<SiYuanTransaction[]>(
      "/api/block/updateBlock",
      { dataType: "markdown", data: markdown, id: blockId },
      "write",
    );
    return { blockId, updated: true };
  }

  private async query(statement: string): Promise<SiYuanBlockRow[]> {
    return this.client.post<SiYuanBlockRow[]>("/api/query/sql", { stmt: statement }, "read");
  }

  private async assertNotebookExists(notebookId: string): Promise<void> {
    const { notebooks } = await this.listNotebooks();
    if (!notebooks.some((notebook) => notebook.id === notebookId)) {
      throw new AppError("NOTEBOOK_NOT_FOUND", "The requested SiYuan notebook does not exist.", 404);
    }
  }

  private async assertDocumentExists(documentId: string): Promise<void> {
    const rows = await this.query(
      `SELECT id FROM blocks WHERE id = '${sqlLiteral(documentId)}' AND type = 'd' LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new AppError("DOCUMENT_NOT_FOUND", "The requested SiYuan document does not exist.", 404);
    }
  }

  private async assertBlockExists(blockId: string): Promise<void> {
    const rows = await this.query(
      `SELECT id FROM blocks WHERE id = '${sqlLiteral(blockId)}' LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new AppError("BLOCK_NOT_FOUND", "The requested SiYuan block does not exist.", 404);
    }
  }
}

function normalizePath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/u, "");
}

function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function escapeLike(value: string): string {
  return sqlLiteral(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function extractOperationIds(transactions: SiYuanTransaction[]): string[] {
  return transactions.flatMap((transaction) =>
    (transaction.doOperations ?? [])
      .filter((operation) => operation.action === "insert" && operation.id)
      .map((operation) => operation.id!),
  );
}
