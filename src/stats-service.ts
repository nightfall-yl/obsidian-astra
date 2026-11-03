import { TFile, TFolder, normalizePath } from "obsidian";
import type { App } from "obsidian";
import {
  buildCumulativeLinkHistory,
  countWords,
  dayKeysEndingToday,
  localDateKey
} from "./core";
import type {
  ActivityEntry,
  AstraDataStore,
  DailyActivity,
  DashboardSnapshot,
  DailyLinkCount,
  FolderSummary,
  KnowledgeGraphSnapshot,
  NoteMetric
} from "./models";

interface CachedMetric {
  mtime: number;
  size: number;
  words: number;
}

export class StatsService {
  private readonly metricCache = new Map<string, CachedMetric>();
  private inFlightScan: Promise<DashboardSnapshot> | null = null;

  constructor(
    private readonly app: App,
    private readonly store: AstraDataStore
  ) {}

  scan(force = false): Promise<DashboardSnapshot> {
    if (force) {
      this.metricCache.clear();
    }
    if (this.inFlightScan) {
      return this.inFlightScan;
    }
    this.inFlightScan = this.performScan().finally(() => {
      this.inFlightScan = null;
    });
    return this.inFlightScan;
  }

  invalidate(path?: string): void {
    if (path) {
      this.metricCache.delete(path);
    } else {
      this.metricCache.clear();
    }
  }

  async recordFileChange(file: TFile, isCreate = false): Promise<void> {
    if (!this.isIncluded(file)) return;

    const newWordCount = await this.currentWordCount(file);
    const previousWordCount = this.store.data.fileWordCounts[file.path];
    const addedWords =
      previousWordCount === undefined
        ? isCreate
          ? newWordCount
          : 0
        : Math.max(0, newWordCount - previousWordCount);
    const today = localDateKey(new Date());
    const entry = this.store.data.activity[today] ?? {
      addedWords: 0,
      edits: 0,
      paths: []
    };

    entry.addedWords += addedWords;
    entry.edits += 1;
    if (!entry.paths.includes(file.path)) {
      entry.paths.push(file.path);
    }
    this.store.data.activity[today] = entry;
    this.store.data.fileWordCounts[file.path] = newWordCount;
    // metricCache 已在 currentWordCount 中刷新为最新内容指纹，不再失效，
    // 后续 modify 事件与 scan 均可直接复用，避免重复全文计数
    this.store.requestDataSave();
  }

  /** 当前词数：stat 指纹（mtime + size）命中缓存时直接复用，避免每次 modify 都全文重数。 */
  private async currentWordCount(file: TFile): Promise<number> {
    const cached = this.metricCache.get(file.path);
    if (
      cached &&
      cached.mtime === file.stat.mtime &&
      cached.size === file.stat.size
    ) {
      return cached.words;
    }
    const content = await this.app.vault.cachedRead(file);
    const words = countWords(content);
    this.metricCache.set(file.path, {
      mtime: file.stat.mtime,
      size: file.stat.size,
      words
    });
    return words;
  }

  recordDelete(file: TFile): void {
    delete this.store.data.fileWordCounts[file.path];
    this.invalidate(file.path);
    this.store.requestDataSave();
  }

  recordRename(file: TFile, oldPath: string): void {
    const previousCount = this.store.data.fileWordCounts[oldPath];
    if (previousCount !== undefined) {
      this.store.data.fileWordCounts[file.path] = previousCount;
      delete this.store.data.fileWordCounts[oldPath];
    }
    Object.values(this.store.data.activity).forEach((entry) => {
      const index = entry.paths.indexOf(oldPath);
      if (index >= 0) entry.paths[index] = file.path;
    });
    this.invalidate(oldPath);
    this.invalidate(file.path);
    this.store.requestDataSave();
  }

  private async performScan(): Promise<DashboardSnapshot> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isIncluded(file));
    const cachedMetrics = await mapWithConcurrency(files, 10, (file) =>
      this.readMetric(file)
    );
    const backlinkCounts = this.buildBacklinkCounts(files);
    const notes: NoteMetric[] = files.map((file, index) => {
      const metric = cachedMetrics[index];
      if (!metric) {
        throw new Error(`Missing metric for ${file.path}`);
      }
      const cache = this.app.metadataCache.getFileCache(file);
      return {
        file,
        words: metric.words,
        backlinks: backlinkCounts.get(file.path) ?? 0,
        outgoingLinks: cache?.links?.length ?? 0
      };
    });

    this.initializeTrackingBaseline(notes);

    const totalWords = notes.reduce((sum, note) => sum + note.words, 0);
    const unlinkedNotes = notes
      .filter((note) => note.backlinks === 0)
      .sort(compareByModifiedAscending);
    const shortNotes = notes
      .filter(
        (note) =>
          note.words <= this.store.data.settings.shortNoteWordThreshold
      )
      .sort((left, right) => left.words - right.words);
    const recentNotes = [...notes]
      .sort(compareByModifiedDescending)
      .slice(0, 5);
    const today = localDateKey(new Date());
    const modifiedToday = notes.filter(
      (note) => localDateKey(note.file.stat.mtime) === today
    ).length;

    // 热力图复用：全库按 mtime 归组的每日篇数。
    // 注意：这里遍历的是 performScan 已经过滤好的 notes（全库 .md - excludedFolders），
    // 与 buildActivity 内部的 notesByMtime 构建逻辑完全同口径，不受 activityHistoryDays 限制。
    const dailyNoteCounts: Record<string, number> = {};
    for (const note of notes) {
      const key = localDateKey(note.file.stat.mtime);
      dailyNoteCounts[key] = (dailyNoteCounts[key] ?? 0) + 1;
    }

    const activity = this.buildActivity(notes);
    const graph = this.buildKnowledgeGraph(notes);
    this.recordLinkSnapshot(graph.edges.length);

    return {
      generatedAt: Date.now(),
      notes,
      noteCount: notes.length,
      totalWords,
      unlinkedNotes,
      shortNotes,
      recentNotes,
      modifiedToday,
      activity,
      trend: activity.slice(-30),
      linkHistory: this.buildLinkHistory(notes, graph),
      folders: this.buildFolderSummaries(notes),
      graph,
      dailyNoteCounts
    };
  }

  private isIncluded(file: TFile): boolean {
    const excluded = this.store.data.settings.excludedFolders
      .map((path) => normalizePath(path.trim()).replace(/\/$/u, ""))
      .filter(Boolean);
    return !excluded.some(
      (path) => file.path === path || file.path.startsWith(`${path}/`)
    );
  }

  private async readMetric(file: TFile): Promise<CachedMetric> {
    const cached = this.metricCache.get(file.path);
    if (
      cached &&
      cached.mtime === file.stat.mtime &&
      cached.size === file.stat.size
    ) {
      return cached;
    }

    const content = await this.app.vault.cachedRead(file);
    const metric: CachedMetric = {
      mtime: file.stat.mtime,
      size: file.stat.size,
      words: countWords(content)
    };
    this.metricCache.set(file.path, metric);
    return metric;
  }

  private buildBacklinkCounts(files: TFile[]): Map<string, number> {
    const includedPaths = new Set(files.map((file) => file.path));
    const counts = new Map<string, number>();
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    Object.values(resolvedLinks).forEach((targets) => {
      Object.keys(targets).forEach((targetPath) => {
        if (includedPaths.has(targetPath)) {
          counts.set(targetPath, (counts.get(targetPath) ?? 0) + 1);
        }
      });
    });
    return counts;
  }

  private initializeTrackingBaseline(notes: NoteMetric[]): void {
    let changed = false;
    if (this.store.data.trackingStartedAt === null) {
      this.store.data.trackingStartedAt = Date.now();
      changed = true;
    }
    notes.forEach((note) => {
      if (this.store.data.fileWordCounts[note.file.path] === undefined) {
        this.store.data.fileWordCounts[note.file.path] = note.words;
        changed = true;
      }
    });
    if (changed) this.store.requestDataSave();
  }

  private buildActivity(notes: NoteMetric[]): DailyActivity[] {
    const historyDays = this.store.data.settings.activityHistoryDays;
    const keys = dayKeysEndingToday(historyDays);
    const trackingStart = this.store.data.trackingStartedAt
      ? localDateKey(this.store.data.trackingStartedAt)
      : localDateKey(new Date());
    const notesByMtime = new Map<string, NoteMetric[]>();
    notes.forEach((note) => {
      const key = localDateKey(note.file.stat.mtime);
      const list = notesByMtime.get(key) ?? [];
      list.push(note);
      notesByMtime.set(key, list);
    });

    return keys.map((date) => {
      const exact = this.store.data.activity[date];
      const isBeforeTracking = date < trackingStart;
      const estimatedNotes =
        this.store.data.settings.showEstimatedHistory && isBeforeTracking
          ? notesByMtime.get(date) ?? []
          : [];
      const exactFiles = (exact?.paths ?? [])
        .map((path) => this.app.vault.getAbstractFileByPath(path))
        .filter((file): file is TFile => file instanceof TFile);
      const files = uniqueFiles([
        ...estimatedNotes.map((note) => note.file),
        ...exactFiles
      ]);
      return {
        date,
        addedWords: isBeforeTracking
          ? estimatedNotes.reduce((sum, note) => sum + note.words, 0)
          : exact?.addedWords ?? 0,
        edits: isBeforeTracking
          ? estimatedNotes.length
          : exact?.edits ?? 0,
        estimated: isBeforeTracking && estimatedNotes.length > 0,
        files
      };
    });
  }

  private buildFolderSummaries(notes: NoteMetric[]): FolderSummary[] {
    const rootFolders = this.app.vault
      .getRoot()
      .children.filter((entry): entry is TFolder => entry instanceof TFolder);

    return rootFolders
      .map((folder) => {
        const folderNotes = notes.filter((note) =>
          note.file.path.startsWith(`${folder.path}/`)
        );
        return {
          path: folder.path,
          name: folder.name,
          noteCount: folderNotes.length,
          wordCount: folderNotes.reduce((sum, note) => sum + note.words, 0),
          files: folderNotes.map((note) => note.file)
        };
      })
      .filter((folder) => folder.noteCount > 0)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private recordLinkSnapshot(count: number): void {
    const today = localDateKey(new Date());
    let changed = false;
    if (this.store.data.linkTrackingStartedAt === null) {
      this.store.data.linkTrackingStartedAt = Date.now();
      changed = true;
    }
    if (this.store.data.linkSnapshots[today] !== count) {
      this.store.data.linkSnapshots[today] = count;
      changed = true;
    }
    // 只保留最近 400 天的链接快照（固定窗口，独立于 activityHistoryDays）
    const snapshotOldestRetained = dayKeysEndingToday(400)[0];
    if (snapshotOldestRetained) {
      Object.keys(this.store.data.linkSnapshots).forEach((date) => {
        if (date < snapshotOldestRetained) {
          delete this.store.data.linkSnapshots[date];
          changed = true;
        }
      });
    }

    // activity 裁剪：与 linkSnapshots 同构，保留窗口 = max(activityHistoryDays + 30, 400)
    // 为什么加 +30：activityHistoryDays 只控制 UI 展示窗口，裁剪窗口应该略宽松，
    // 避免用户把 activityHistoryDays 设为更大值时发现历史数据已被清掉。
    const retentionDays = Math.max(
      (this.store.data.settings.activityHistoryDays ?? 365) + 30,
      400
    );
    changed = pruneActivityRecords(this.store.data.activity, retentionDays) || changed;

    if (changed) this.store.requestDataSave();
  }

  private buildLinkHistory(
    notes: NoteMetric[],
    graph: KnowledgeGraphSnapshot
  ): DailyLinkCount[] {
    const notesByPath = new Map(
      notes.map((note) => [note.file.path, note] as const)
    );
    const estimatedLinkDates = graph.edges.map((edge) => {
      const source = notesByPath.get(edge.source);
      return localDateKey(source?.file.stat.mtime ?? Date.now());
    });
    return buildCumulativeLinkHistory(
      dayKeysEndingToday(365),
      estimatedLinkDates,
      this.store.data.linkSnapshots,
      this.store.data.linkTrackingStartedAt
    );
  }

  private buildKnowledgeGraph(notes: NoteMetric[]): KnowledgeGraphSnapshot {
    const includedPaths = new Set(notes.map((note) => note.file.path));
    const degree = new Map<string, number>();
    const edges = new Map<string, { source: string; target: string }>();

    Object.entries(this.app.metadataCache.resolvedLinks).forEach(
      ([source, targets]) => {
        if (!includedPaths.has(source)) return;
        Object.keys(targets).forEach((target) => {
          if (!includedPaths.has(target) || source === target) return;
          const key = `${source}\u0000${target}`;
          if (edges.has(key)) return;
          edges.set(key, { source, target });
          degree.set(source, (degree.get(source) ?? 0) + 1);
          degree.set(target, (degree.get(target) ?? 0) + 1);
        });
      }
    );

    return {
      nodes: notes.map((note) => ({
        file: note.file,
        degree: degree.get(note.file.path) ?? 0
      })),
      edges: [...edges.values()]
    };
  }

}

function compareByModifiedDescending(
  left: NoteMetric,
  right: NoteMetric
): number {
  return right.file.stat.mtime - left.file.stat.mtime;
}

function compareByModifiedAscending(
  left: NoteMetric,
  right: NoteMetric
): number {
  return left.file.stat.mtime - right.file.stat.mtime;
}

function uniqueFiles(files: TFile[]): TFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await mapper(item);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export function mergeActivityEntry(
  current: ActivityEntry | undefined,
  update: Partial<ActivityEntry>
): ActivityEntry {
  return {
    addedWords: (current?.addedWords ?? 0) + (update.addedWords ?? 0),
    edits: (current?.edits ?? 0) + (update.edits ?? 0),
    paths: Array.from(
      new Set([...(current?.paths ?? []), ...(update.paths ?? [])])
    )
  };
}

/**
 * 裁剪 activity 记录 + 收敛 paths 重复项。纯函数，可单测。
 * 日期 key 为 YYYY-MM-DD 字符串，直接字符串比较即可判定先后。
 * @returns 是否发生了改动（新增/删除日期 key 或 paths 去重）
 */
export function pruneActivityRecords(
  activity: Record<string, ActivityEntry>,
  retentionDays: number,
  now: Date = new Date()
): boolean {
  const oldestRetained = dayKeysEndingToday(retentionDays, now)[0];
  let changed = false;
  if (oldestRetained) {
    for (const date of Object.keys(activity)) {
      if (date < oldestRetained) {
        delete activity[date];
        changed = true;
      }
    }
  }
  for (const entry of Object.values(activity)) {
    const unique = [...new Set(entry.paths)];
    if (unique.length < entry.paths.length) {
      entry.paths = unique;
      changed = true;
    }
  }
  return changed;
}
