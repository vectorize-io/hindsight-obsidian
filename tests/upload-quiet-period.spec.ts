import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, type PluginManifest, TFile } from "obsidian";
import HindsightPlugin from "../src/main";
import type { HindsightSettings } from "../src/settings";

function file(path: string, mtime: number): TFile {
  return Object.assign(new TFile(), { path, extension: "md", stat: { mtime, ctime: mtime } });
}

const reconcileSummary = { added: 0, updated: 2, deleted: 0, unchanged: 0 };

function fixture(period: number) {
  const files = new Map<string, TFile>();
  const events = new Map<string, (...args: unknown[]) => void>();
  const ingestFile = vi.fn(async (_file: TFile) => "created");
  const reconcile = vi.fn(async () => reconcileSummary);
  const scheduleFlush = Object.assign(vi.fn(), { cancel: vi.fn() });
  const plugin = new HindsightPlugin({} as App, {} as PluginManifest) as unknown as {
    settings: HindsightSettings;
    app: App;
    dirty: Set<string>;
    engine: {
      ingestFile: typeof ingestFile;
      reconcile: typeof reconcile;
      handleDelete: ReturnType<typeof vi.fn>;
      handleRename: ReturnType<typeof vi.fn>;
    };
    registerEvent(event: unknown): void;
    registerVaultWatchers(): void;
    scheduleFlush: typeof scheduleFlush;
    scheduleDirtyFlush(): void;
    syncVault(): Promise<void>;
    savePluginData(): Promise<void>;
    reportError(err: unknown): void;
    flushDirty(): Promise<void>;
    updateStatusBar(): void;
  };
  plugin.settings.uploadQuietPeriod = period;
  plugin.app = { vault: {
    getAbstractFileByPath: (path: string) => files.get(path),
    on: (name: string, callback: (...args: unknown[]) => void) => {
      events.set(name, callback);
      return {};
    },
  } } as unknown as App;
  plugin.engine = {
    ingestFile,
    reconcile,
    handleDelete: vi.fn(async () => {}),
    handleRename: vi.fn(async () => {}),
  };
  plugin.scheduleFlush = scheduleFlush;
  plugin.updateStatusBar = vi.fn();
  plugin.savePluginData = vi.fn(async () => {});
  plugin.reportError = vi.fn();
  plugin.registerEvent = vi.fn();
  plugin.registerVaultWatchers();
  const emit = (event: string, ...args: unknown[]) => events.get(event)!(...args);
  return { plugin, files, ingestFile, scheduleFlush, emit };
}

describe("automatic upload quiet period", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the old flush path when off", () => {
    const { plugin, scheduleFlush } = fixture(0);
    plugin.dirty.add("a.md");
    plugin.scheduleDirtyFlush();
    expect(scheduleFlush).toHaveBeenCalledOnce();
  });

  it("waits for a full quiet period after the latest modification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    files.set("a.md", file("a.md", Date.now()));
    emit("modify", files.get("a.md"));

    await vi.advanceTimersByTimeAsync(40_000);
    expect(ingestFile).not.toHaveBeenCalled();
    files.get("a.md")!.stat.mtime = Date.now();
    emit("modify", files.get("a.md"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ingestFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile).toHaveBeenCalledOnce();
    expect(plugin.dirty.size).toBe(0);
  });

  it("reconciles immediately and cancels pending automatic uploads on manual sync", async () => {
    vi.useFakeTimers();
    const { plugin, files, ingestFile, scheduleFlush, emit } = fixture(60_000);
    for (const path of ["a.md", "b.md"]) {
      const note = file(path, Date.now());
      files.set(path, note);
      emit("modify", note);
    }
    expect(vi.getTimerCount()).toBe(1);

    const sync = plugin.syncVault();
    expect(plugin.engine.reconcile).toHaveBeenCalledOnce();
    expect(scheduleFlush.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await sync;
    expect(plugin.dirty.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("keeps edits made during manual sync on their own quiet period", async () => {
    vi.useFakeTimers();
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    const note = file("a.md", Date.now());
    files.set(note.path, note);
    emit("modify", note);
    let finish!: () => void;
    plugin.engine.reconcile.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve(reconcileSummary);
    }));

    const sync = plugin.syncVault();
    await vi.advanceTimersByTimeAsync(10_000);
    emit("modify", note);
    await plugin.syncVault(); // a second click must not take over the newer edit
    expect(plugin.engine.reconcile).toHaveBeenCalledOnce();
    finish();
    await sync;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ingestFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile).toHaveBeenCalledExactlyOnceWith(note);
  });

  it("does not let an in-flight automatic upload consume edits after manual sync", async () => {
    vi.useFakeTimers();
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    const first = file("first.md", Date.now());
    const next = file("next.md", Date.now());
    for (const note of [first, next]) {
      files.set(note.path, note);
      emit("modify", note);
    }
    let finish!: () => void;
    ingestFile.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve("created");
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingestFile).toHaveBeenCalledExactlyOnceWith(first);
    await plugin.syncVault();
    emit("modify", first);
    finish();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(ingestFile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile.mock.calls).toEqual([[first], [first]]);
  });

  it("restores pending uploads after a failed manual sync, except deleted notes", async () => {
    vi.useFakeTimers();
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    const kept = file("kept.md", Date.now());
    const deleted = file("deleted.md", Date.now());
    for (const note of [kept, deleted]) {
      files.set(note.path, note);
      emit("modify", note);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    const error = new Error("reconcile failed");
    let fail!: () => void;
    plugin.engine.reconcile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(error);
    }));

    const sync = plugin.syncVault();
    files.delete(deleted.path);
    emit("delete", deleted);
    fail();
    await sync;
    expect(plugin.reportError).toHaveBeenCalledWith(error);
    expect(plugin.dirty).toEqual(new Set([kept.path]));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(ingestFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile).toHaveBeenCalledExactlyOnceWith(kept);
  });

  it("waits a full quiet period after renaming an old note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    const renamedNote = file("new.md", 1_000);
    files.set("new.md", renamedNote);
    emit("rename", renamedNote, "old.md");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ingestFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile).toHaveBeenCalledOnce();
    expect(ingestFile).toHaveBeenCalledWith(renamedNote);
    expect(plugin.dirty.size).toBe(0);
  });

  it("resets the rename quiet period when the note changes again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { files, ingestFile, emit } = fixture(60_000);
    const renamed = file("new.md", 1_000);
    files.set("new.md", renamed);
    emit("rename", renamed, "old.md");
    await vi.advanceTimersByTimeAsync(40_000);
    emit("modify", renamed); // mtime is still the old value
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ingestFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile).toHaveBeenCalledOnce();
  });

  it("cancels pending uploads when automatic sync is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { plugin, files, ingestFile, scheduleFlush, emit } = fixture(60_000);
    files.set("a.md", file("a.md", Date.now()));
    emit("modify", files.get("a.md"));
    const instance = plugin as unknown as {
      rebuildClient(): void;
      savePluginData(): Promise<void>;
      saveSettings(): Promise<void>;
    };
    instance.rebuildClient = vi.fn();
    instance.savePluginData = vi.fn(async () => {});
    plugin.settings.syncOnEdit = false;
    await instance.saveSettings();
    expect(scheduleFlush.cancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingestFile).not.toHaveBeenCalled();
    expect(plugin.dirty.size).toBe(0);
  });

  it("does not overlap flushes and reschedules edits arriving during ingestion", async () => {
    const { plugin, files, ingestFile, scheduleFlush } = fixture(0);
    files.set("a.md", file("a.md", Date.now()));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    ingestFile.mockImplementationOnce(async () => { await pending; return "created"; });
    plugin.dirty.add("a.md");
    const first = plugin.flushDirty();
    plugin.dirty.add("a.md"); // a second edit arrives while the first upload is in flight
    await plugin.flushDirty();
    expect(ingestFile).toHaveBeenCalledOnce();
    finish();
    await first;
    expect(scheduleFlush).toHaveBeenCalledOnce();
    await plugin.flushDirty();
    expect(ingestFile).toHaveBeenCalledTimes(2);
  });

  it("deletes immediately and cancels the pending upload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    const note = file("a.md", 1_000);
    files.set(note.path, note);
    emit("modify", note);
    files.delete(note.path);
    emit("delete", note);
    expect(plugin.engine.handleDelete).toHaveBeenCalledWith(note.path);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingestFile).not.toHaveBeenCalled();
    expect(plugin.dirty.size).toBe(0);
  });

  it("keeps an in-flight edit pending for its own full quiet period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { plugin, files, ingestFile, emit } = fixture(30_000);
    const note = file("a.md", 1_000);
    files.set(note.path, note);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    ingestFile.mockImplementationOnce(async () => { await pending; return "created"; });
    emit("modify", note);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ingestFile).toHaveBeenCalledOnce();
    emit("modify", note);
    finish();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ingestFile).toHaveBeenCalledOnce();
    expect(plugin.dirty.has(note.path)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestFile).toHaveBeenCalledTimes(2);
  });

  it("uploads a quiet note even while another keeps changing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { plugin, files, ingestFile, emit } = fixture(60_000);
    files.set("quiet.md", file("quiet.md", Date.now()));
    files.set("active.md", file("active.md", Date.now()));
    emit("modify", files.get("quiet.md"));
    emit("modify", files.get("active.md"));
    await vi.advanceTimersByTimeAsync(50_000);
    files.get("active.md")!.stat.mtime = Date.now();
    emit("modify", files.get("active.md"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ingestFile).toHaveBeenCalledOnce();
    expect(ingestFile).toHaveBeenCalledWith(files.get("quiet.md"));
    expect(plugin.dirty.has("active.md")).toBe(true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(ingestFile).toHaveBeenCalledTimes(2);
  });
});
