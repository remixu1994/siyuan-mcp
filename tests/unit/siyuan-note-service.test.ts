import { describe, expect, it, vi } from "vitest";
import { SiYuanClient } from "../../src/services/siyuan-client.js";
import { SiYuanNoteService } from "../../src/services/siyuan-note-service.js";

describe("SiYuanNoteService", () => {
  it("maps the documented SiYuan read and write endpoints", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce([{ id: "doc", root_id: "doc", type: "d" }])
      .mockResolvedValueOnce({ hPath: "/Doc", content: "# Doc" })
      .mockResolvedValueOnce({ notebooks: [{ id: "box", name: "Notes", closed: false }] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce("new-doc")
      .mockResolvedValueOnce([{ id: "doc", root_id: "doc", type: "d" }])
      .mockResolvedValueOnce([{ doOperations: [{ action: "insert", id: "new-block" }] }])
      .mockResolvedValueOnce([{ id: "block", root_id: "doc", type: "p" }])
      .mockResolvedValueOnce([]);
    const service = new SiYuanNoteService({ post } as unknown as SiYuanClient);

    await expect(service.getDocument("doc")).resolves.toEqual({
      documentId: "doc",
      path: "/Doc",
      markdown: "# Doc",
    });
    await expect(service.createDocument("box", "/New", "# New")).resolves.toEqual({
      documentId: "new-doc",
      path: "/New",
      created: true,
    });
    await expect(service.appendContent("doc", "More")).resolves.toEqual({
      documentId: "doc",
      appended: true,
      blockIds: ["new-block"],
    });
    await expect(service.updateBlock("block", "Changed")).resolves.toEqual({
      blockId: "block",
      updated: true,
    });

    expect(post.mock.calls.map((call) => call[0])).toEqual([
      "/api/query/sql",
      "/api/export/exportMdContent",
      "/api/notebook/lsNotebooks",
      "/api/filetree/getIDsByHPath",
      "/api/filetree/createDocWithMd",
      "/api/query/sql",
      "/api/block/appendBlock",
      "/api/query/sql",
      "/api/block/updateBlock",
    ]);
  });

  it("keeps SQL server-controlled and escapes search input", async () => {
    const post = vi.fn().mockResolvedValue([]);
    const service = new SiYuanNoteService({ post } as unknown as SiYuanClient);
    await service.searchNotes("x' OR 1=1 --", 20);
    const statement = post.mock.calls[0]?.[1]?.stmt as string;
    expect(statement).toContain("x'' OR 1=1 --");
    expect(statement).toContain("LIMIT 20");
  });
});
