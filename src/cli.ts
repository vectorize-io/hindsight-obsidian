import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { FetchHindsightClient } from "./fetch-client";
import {
  SyncEngine,
  compareSyncFiles,
  requiredProvenanceTags,
  type ReconcileProgress,
  type SyncFile,
  type SyncIndex,
  type SyncVault,
} from "./sync";

interface CliOptions {
  vault: string;
  apiUrl: string;
  bank: string;
  vaultName: string;
  state: string;
  log: string;
  seedIndex?: string;
  includes: string[];
  excludes: string[];
  maxFiles?: number;
  dryRun: boolean;
  patchTags: boolean;
}

interface RunnerState {
  version: 1;
  vaultName: string;
  bank: string;
  updatedAt: string;
  index: SyncIndex;
}

function values(args: string[], name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) found.push(...args[++i].split(",").filter(Boolean));
  }
  return found;
}

function value(args: string[], name: string): string | undefined {
  return values(args, name)[0];
}

function requireValue(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`Missing required ${name}`);
  return result;
}

function parseArgs(args: string[]): CliOptions {
  const vault = path.resolve(requireValue(args, "--vault"));
  const bank = requireValue(args, "--bank");
  const state = path.resolve(requireValue(args, "--state"));
  const maxFilesRaw = value(args, "--max-files");
  const maxFiles = maxFilesRaw ? Number.parseInt(maxFilesRaw, 10) : undefined;
  if (maxFiles !== undefined && (!Number.isFinite(maxFiles) || maxFiles < 1)) {
    throw new Error("--max-files must be a positive integer");
  }
  return {
    vault,
    apiUrl: requireValue(args, "--api-url"),
    bank,
    vaultName: value(args, "--vault-name") ?? path.basename(vault),
    state,
    log: path.resolve(value(args, "--log") ?? `${state}.jsonl`),
    seedIndex: value(args, "--seed-index"),
    includes: values(args, "--include"),
    excludes: values(args, "--exclude"),
    maxFiles,
    dryRun: args.includes("--dry-run"),
    patchTags: !args.includes("--no-tag-patch"),
  };
}

function underFolder(filePath: string, folder: string): boolean {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  if (!normalized) return true;
  return filePath === normalized || filePath.startsWith(`${normalized}/`);
}

function shouldSelect(filePath: string, options: CliOptions): boolean {
  if (options.excludes.some((folder) => underFolder(filePath, folder))) return false;
  if (options.includes.length === 0) return true;
  return options.includes.some((folder) => underFolder(filePath, folder));
}

async function collectMarkdownFiles(root: string): Promise<SyncFile[]> {
  const files: SyncFile[] = [];
  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(root, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Match the visible Obsidian vault: configuration, trash, and agent
        // implementation directories are not knowledge notes.
        if (!entry.name.startsWith(".")) await walk(relative);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const fileStat = await stat(path.join(root, relative));
        files.push({
          path: relative,
          stat: { mtime: fileStat.mtimeMs, ctime: fileStat.birthtimeMs || fileStat.ctimeMs },
        });
      }
    }
  }
  await walk("");
  return files.sort(compareSyncFiles);
}

function filesystemVault(root: string, files: SyncFile[]): SyncVault {
  return {
    getMarkdownFiles: () => files,
    read: async (file) => readFile(path.join(root, file.path), "utf8"),
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function loadState(options: CliOptions): Promise<RunnerState> {
  try {
    const current = (await readJson(options.state)) as RunnerState;
    if (current.bank !== options.bank || current.vaultName !== options.vaultName) {
      throw new Error("State bank/vault identity does not match this run");
    }
    return current;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  let index: SyncIndex = {};
  if (options.seedIndex) {
    const seed = (await readJson(path.resolve(options.seedIndex))) as {
      syncIndex?: SyncIndex;
      index?: SyncIndex;
    };
    index = seed.syncIndex ?? seed.index ?? {};
  }
  return {
    version: 1,
    vaultName: options.vaultName,
    bank: options.bank,
    updatedAt: new Date().toISOString(),
    index,
  };
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const collected = await collectMarkdownFiles(options.vault);
  const eligible = collected.filter((file) => shouldSelect(file.path, options));
  const selected = options.maxFiles ? eligible.slice(0, options.maxFiles) : eligible;
  const taskCount = selected.filter((file) => file.path.startsWith("TaskNotes/Tasks/")).length;

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ total: selected.length, taskNotes: taskCount, first: selected.slice(0, 20) }, null, 2)}\n`
    );
    return;
  }

  const client = new FetchHindsightClient(options.apiUrl, process.env.HINDSIGHT_API_KEY);
  if (!(await client.health())) throw new Error(`Hindsight is not reachable at ${options.apiUrl}`);
  const state = await loadState(options);
  const serverDocuments = await client.listDocuments(options.bank);
  const selectedPaths = new Set(selected.map((file) => file.path));
  let missingServerCheckpointsCleared = 0;
  for (const indexedPath of Object.keys(state.index)) {
    if (
      selectedPaths.has(indexedPath) &&
      !serverDocuments.has(`${options.vaultName}/${indexedPath}`)
    ) {
      delete state.index[indexedPath];
      missingServerCheckpointsCleared++;
    }
  }
  const started = Date.now();
  let tagPatches = 0;
  await mkdir(path.dirname(options.log), { recursive: true });

  const plannedSubmissionsUpperBound = selected.filter((file) => {
    const previous = state.index[file.path];
    return (
      !previous ||
      previous.mtime !== file.stat.mtime ||
      !serverDocuments.has(`${options.vaultName}/${file.path}`)
    );
  }).length;
  const plannedTagPatches = selected.filter((file) => {
    const existing = serverDocuments.get(`${options.vaultName}/${file.path}`);
    if (!existing) return false;
    return requiredProvenanceTags(file.path, options.vaultName).some(
      (required) => !existing.includes(required)
    );
  }).length;
  const preflightEvent = {
    at: new Date().toISOString(),
    event: "preflight",
    total: selected.length,
    taskNotes: taskCount,
    serverDocuments: serverDocuments.size,
    seededCheckpoints: Object.keys(state.index).length,
    missingServerCheckpointsCleared,
    plannedSubmissionsUpperBound,
    plannedTagPatches,
    prune: false,
  };
  await appendFile(options.log, `${JSON.stringify(preflightEvent)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(preflightEvent)}\n`);

  const persist = async (index: SyncIndex): Promise<void> => {
    state.index = index;
    state.updatedAt = new Date().toISOString();
    await atomicWriteJson(options.state, state);
  };
  const engine = new SyncEngine(
    client,
    filesystemVault(options.vault, selected),
    {
      bankId: options.bank,
      includeFolders: options.includes,
      excludeFolders: options.excludes,
      vaultName: options.vaultName,
      prefixDocId: true,
    },
    state.index,
    persist
  );

  const onProgress = async (progress: ReconcileProgress): Promise<void> => {
    const documentId = `${options.vaultName}/${progress.path}`;
    let tagPatched = false;
    if (options.patchTags && serverDocuments.has(documentId)) {
      const currentTags =
        progress.outcome === "skipped"
          ? (serverDocuments.get(documentId) ?? [])
          : await client.getDocumentTags(options.bank, documentId);
      const requiredTags = requiredProvenanceTags(progress.path, options.vaultName);
      const mergedTags = [...new Set([...currentTags, ...requiredTags])];
      if (mergedTags.length !== currentTags.length) {
        await client.updateDocumentTags(options.bank, documentId, mergedTags);
        serverDocuments.set(documentId, mergedTags);
        tagPatches++;
        tagPatched = true;
      }
    }
    const elapsedSeconds = Math.max(1, (Date.now() - started) / 1_000);
    const ratePerHour = (progress.completed / elapsedSeconds) * 3_600;
    const event = {
      at: new Date().toISOString(),
      ...progress,
      tagPatched,
      tagPatches,
      missingServerCheckpointsCleared,
      elapsedSeconds: Math.round(elapsedSeconds),
      ratePerHour: Math.round(ratePerHour * 10) / 10,
      retainRatePerHour:
        Math.round(
          (((progress.summary.added + progress.summary.updated) / elapsedSeconds) * 3_600) * 10
        ) / 10,
    };
    await appendFile(options.log, `${JSON.stringify(event)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  const summary = await engine.reconcile({
    prune: false,
    concurrency: 1,
    continueOnError: true,
    onProgress,
  });
  const finalEvent = {
    at: new Date().toISOString(),
    event: "complete",
    summary,
    tagPatches,
    missingServerCheckpointsCleared,
  };
  await appendFile(options.log, `${JSON.stringify(finalEvent)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(finalEvent)}\n`);
  if (summary.failed > 0) process.exitCode = 2;
}

run().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
