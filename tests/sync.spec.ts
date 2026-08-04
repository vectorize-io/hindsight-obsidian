import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HindsightClient } from "../src/client";
import { SyncEngine, type SyncConfig, type SyncIndex, type SyncVault } from "../src/sync";

interface FileSpec {
  content: string;
  mtime: number;
  ctime: number;
}

function fakeClient() {
  return {
    retain: vi.fn(async (_bank: string, _docId: string, _content: string, _opts?: unknown) => ({
      operationId: "op-1",
      status: "completed" as const,
      completedAt: "T0",
    })),
    deleteDocument: vi.fn(async (_bank: string, _docId: string) => {}),
  };
}

function fakeVault(files: Record<string, FileSpec>): SyncVault {
  return {
    getMarkdownFiles: () =>
      Object.keys(files).map((path) => ({
        path,
        stat: { mtime: files[path].mtime, ctime: files[path].ctime },
      })),
    read: async (file) => files[file.path].content,
  };
}

const BASE_CONFIG: SyncConfig = {
  bankId: "bank",
  includeFolders: [],
  excludeFolders: [],
  vaultName: "Vault",
  prefixDocId: false,
};

function makeEngine(
  files: Record<string, FileSpec>,
  index: SyncIndex = {},
  config: Partial<SyncConfig> = {}
) {
  const client = fakeClient();
  const persist = vi.fn(async () => {});
  const engine = new SyncEngine(
    client as unknown as HindsightClient,
    fakeVault(files),
    { ...BASE_CONFIG, ...config },
    index,
    persist,
    () => "T0"
  );
  return { client, engine, index, persist, vault: fakeVault(files) };
}

describe("SyncEngine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a document on first ingest, then skips when unchanged", async () => {
    const files = { "a.md": { content: "# A\nhello world", mtime: 1, ctime: 0 } };
    const { engine, client, vault } = makeEngine(files);
    const file = vault.getMarkdownFiles()[0];

    expect(await engine.ingestFile(file)).toBe("created");
    expect(client.retain).toHaveBeenCalledTimes(1);
    expect(client.retain).toHaveBeenCalledWith(
      "bank",
      "a.md",
      "# A\nhello world",
      expect.objectContaining({ updateMode: "replace" })
    );

    // Same mtime → skipped without a read or retain.
    expect(await engine.ingestFile(file)).toBe("skipped");
    expect(client.retain).toHaveBeenCalledTimes(1);
  });

  it("attaches auto-scope tags (vault, folder ancestors, date buckets) and vault-prefixed id", async () => {
    const created = Date.UTC(2026, 2, 15); // 2026-03
    const updated = Date.UTC(2026, 5, 20); // 2026-06
    const files = {
      "Work/Clients/acme.md": { content: "deal notes", mtime: updated, ctime: created },
    };
    const { engine, client } = makeEngine(files, {}, { vaultName: "Personal", prefixDocId: true });

    await engine.reconcile();

    const [, docId, , opts] = client.retain.mock.calls[0] as [
      string,
      string,
      string,
      { tags: string[]; metadata: Record<string, string>; observationScopes: string[][] },
    ];
    expect(docId).toBe("Personal/Work/Clients/acme.md");
    expect(opts.tags).toEqual(
      expect.arrayContaining([
        "vault:Personal",
        "folder:Work",
        "folder:Work/Clients",
        "created:2026",
        "created:2026-03",
        "updated:2026",
        "updated:2026-06",
        "source:obsidian",
        "lifecycle:current",
        "kind:other",
      ])
    );
    expect(opts.observationScopes).toEqual([
      ["source:obsidian", "vault:Personal", "lifecycle:current"],
    ]);
    expect(opts.metadata.path).toBe("Work/Clients/acme.md");
    expect(opts.metadata.vault).toBe("Personal");
  });

  it("retains full frontmatter while using parsed fields for metadata", async () => {
    const raw = "---\nstatus: open\ntags: [project]\n---\n# Plan\nBody";
    const files = { "TaskNotes/Tasks/plan.md": { content: raw, mtime: 1, ctime: 0 } };
    const { engine, client, vault, index } = makeEngine(files);
    await engine.ingestFile(vault.getMarkdownFiles()[0]);
    expect(client.retain.mock.calls[0][2]).toBe(raw);
    expect(client.retain.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        tags: expect.arrayContaining(["kind:task", "lifecycle:current"]),
      })
    );
    expect(index["TaskNotes/Tasks/plan.md"]).toMatchObject({
      operationId: "op-1",
      operationStatus: "completed",
    });
  });

  it("re-ingests (updated) when content changes", async () => {
    const index: SyncIndex = {};
    const filesV1 = { "a.md": { content: "v1", mtime: 1, ctime: 0 } };
    const { engine: e1, vault: v1vault } = makeEngine(filesV1, index);
    await e1.ingestFile(v1vault.getMarkdownFiles()[0]);

    const filesV2 = { "a.md": { content: "v2 changed", mtime: 2, ctime: 0 } };
    const client = fakeClient();
    const engine = new SyncEngine(
      client as unknown as HindsightClient,
      fakeVault(filesV2),
      BASE_CONFIG,
      index,
      vi.fn(async () => {}),
      () => "T1"
    );
    const file = fakeVault(filesV2).getMarkdownFiles()[0];
    expect(await engine.ingestFile(file)).toBe("updated");
    expect(client.retain).toHaveBeenCalledTimes(1);
  });

  it("hash-gate: skips re-ingest when mtime moved but content is identical", async () => {
    const index: SyncIndex = {};
    const v1 = { "a.md": { content: "same", mtime: 1, ctime: 0 } };
    const { engine: e1, vault: v1vault } = makeEngine(v1, index);
    await e1.ingestFile(v1vault.getMarkdownFiles()[0]);

    const v2 = { "a.md": { content: "same", mtime: 999, ctime: 0 } };
    const client = fakeClient();
    const engine = new SyncEngine(
      client as unknown as HindsightClient,
      fakeVault(v2),
      BASE_CONFIG,
      index,
      vi.fn(async () => {}),
      () => "T1"
    );
    expect(await engine.ingestFile(fakeVault(v2).getMarkdownFiles()[0])).toBe("skipped");
    expect(client.retain).not.toHaveBeenCalled();
  });

  it("deletes a document on note delete (only if previously synced)", async () => {
    const index: SyncIndex = { "a.md": { hash: "h", mtime: 1, syncedAt: "T0" } };
    const { engine, client } = makeEngine({}, index);

    await engine.handleDelete("a.md");
    expect(client.deleteDocument).toHaveBeenCalledWith("bank", "a.md");
    expect(index["a.md"]).toBeUndefined();

    // Unknown path → no-op.
    await engine.handleDelete("never-synced.md");
    expect(client.deleteDocument).toHaveBeenCalledTimes(1);
  });

  it("rename = delete old document + ingest new path", async () => {
    const index: SyncIndex = { "old.md": { hash: "h", mtime: 1, syncedAt: "T0" } };
    const files = { "new.md": { content: "moved", mtime: 2, ctime: 0 } };
    const { engine, client } = makeEngine(files, index);
    const file = fakeVault(files).getMarkdownFiles()[0];

    await engine.handleRename(file, "old.md");
    expect(client.deleteDocument).toHaveBeenCalledWith("bank", "old.md");
    expect(client.retain).toHaveBeenCalledWith(
      "bank",
      "new.md",
      "moved",
      expect.objectContaining({ updateMode: "replace" })
    );
  });

  it("reconcile ingests live notes and prunes orphaned documents", async () => {
    const index: SyncIndex = { "gone.md": { hash: "h", mtime: 1, syncedAt: "T0" } };
    const files = { "kept.md": { content: "kept", mtime: 1, ctime: 0 } };
    const { engine, client } = makeEngine(files, index);

    const summary = await engine.reconcile();
    expect(summary.added).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(client.deleteDocument).toHaveBeenCalledWith("bank", "gone.md");
    expect(index["gone.md"]).toBeUndefined();
  });

  it("reconcile processes TaskNotes first, then each lane newest-first, and checkpoints", async () => {
    const files = {
      "Areas/newest.md": { content: "newest area", mtime: 400, ctime: 1 },
      "TaskNotes/Tasks/older.md": { content: "older task", mtime: 100, ctime: 1 },
      "Notes/older.md": { content: "older note", mtime: 200, ctime: 1 },
      "TaskNotes/Tasks/newer.md": { content: "newer task", mtime: 300, ctime: 1 },
    };
    const { engine, client, persist } = makeEngine(files);

    const summary = await engine.reconcile({ prune: false });

    expect(client.retain.mock.calls.map((call) => call[1])).toEqual([
      "TaskNotes/Tasks/newer.md",
      "TaskNotes/Tasks/older.md",
      "Areas/newest.md",
      "Notes/older.md",
    ]);
    expect(persist).toHaveBeenCalledTimes(5); // one per note plus the final snapshot
    expect(summary).toMatchObject({ added: 4, deleted: 0, failed: 0 });
  });

  it("safe backfill mode does not prune indexed documents missing from the manifest", async () => {
    const index: SyncIndex = { "gone.md": { hash: "h", mtime: 1, syncedAt: "T0" } };
    const { engine, client } = makeEngine({}, index);

    const summary = await engine.reconcile({ prune: false });

    expect(client.deleteDocument).not.toHaveBeenCalled();
    expect(index["gone.md"]).toBeDefined();
    expect(summary.deleted).toBe(0);
  });

  it("can bypass the local checkpoint for selected TaskNotes", async () => {
    const files = {
      "TaskNotes/Tasks/task.md": { content: "task", mtime: 1, ctime: 1 },
      "Areas/area.md": { content: "area", mtime: 1, ctime: 1 },
    };
    const index: SyncIndex = {
      "TaskNotes/Tasks/task.md": { hash: "old", mtime: 1, syncedAt: "T0" },
      "Areas/area.md": { hash: "old", mtime: 1, syncedAt: "T0" },
    };
    const { engine, client } = makeEngine(files, index);

    await engine.reconcile({
      prune: false,
      force: (file) => file.path.startsWith("TaskNotes/Tasks/"),
    });

    expect(client.retain.mock.calls.map((call) => call[1])).toEqual([
      "TaskNotes/Tasks/task.md",
    ]);
  });

  it("falls back to the file creation time for unresolved template timestamps", async () => {
    const files = {
      "Templates/daily.md": {
        content: '---\ncreated: "{{date}}"\n---\nTemplate body',
        mtime: 2_000,
        ctime: 1_000,
      },
    };
    const { engine, client, vault } = makeEngine(files);

    await engine.ingestFile(vault.getMarkdownFiles()[0]);

    expect(client.retain.mock.calls[0][3]).toEqual(
      expect.objectContaining({ timestamp: "1970-01-01T00:00:01.000Z" })
    );
  });

  it("respects exclude folders and vault-prefixed document ids", async () => {
    const files = {
      "Private/secret.md": { content: "secret", mtime: 1, ctime: 0 },
      "Notes/keep.md": { content: "keep", mtime: 1, ctime: 0 },
    };
    const { engine, client } = makeEngine(
      files,
      {},
      {
        excludeFolders: ["Private"],
        prefixDocId: true,
      }
    );

    await engine.reconcile();
    const docIds = client.retain.mock.calls.map((c) => c[1]);
    expect(docIds).toContain("Vault/Notes/keep.md");
    expect(docIds).not.toContain("Vault/Private/secret.md");
  });
});
