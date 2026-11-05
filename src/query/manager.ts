// ================= Astra 通用查询：```astra 代码块处理器 =================
// 注册 Obsidian 的 "astra" 代码块处理器，按查询类型收集行数据
// （TABLE/LIST = frontmatter 行；TASK = 正文任务项）→ 按固定顺序执行子句
// （FROM → WHERE → SORT → LIMIT，与 Dataview 一致）→ 按类型分发渲染。
// 宿主管理器模式参照 linter/manager.ts。

import { TFile, TFolder, parseFrontMatterTags } from "obsidian";
import type {
  App,
  CachedMetadata,
  Plugin,
  TAbstractFile,
} from "obsidian";
import {
  parseQuery,
  type CommonClauses,
  type FromSource,
  type ListQuery,
  type Query,
  type TableQuery,
} from "./parser";
import { parseFrontmatter } from "../data/taskParser";
import { t as $t } from "../i18n";
import {
  compareValues,
  evaluateExpression,
  evaluateWhere,
  formatCellValue,
  isEmptyValue,
  resolveFieldValue,
  type FieldContext
} from "./evaluate";
import { toggleTaskInLines, type WritebackResult } from "./taskWriteback";
import { buildOutlinks } from "./outlinks";

/** frontmatter 行：TABLE / LIST 的数据源。 */
interface Row {
  kind: "frontmatter";
  file: TFile;
  frontmatter: Record<string, unknown>;
}

/** 正文任务项：TASK 的数据源。 */
interface TaskRow {
  kind: "task";
  file: TFile;
  /** checkbox 状态字符（" " 未完成、"x" 完成，也可能为 "/" 等自定义字符） */
  status: string;
  /** 任务文本（checkbox 之后的内容） */
  text: string;
  /** 任务所在行号（0 起，与 Obsidian 缓存一致） */
  line: number;
  /** 所在章节标题；无标题时为 "" */
  section: string;
}

type QueryRow = Row | TaskRow;

/** 行 → 可求值上下文（TASK 行附带任务字段，frontmatter 行附带 frontmatter）。 */
function rowContext(row: QueryRow, app: App): FieldContext {
  // 与 Dataview 对齐：路径比较统一在「已解析路径」层面
  const resolveLink = (target: string): string | null => {
    if (target === "" || target === row.file.path) return row.file.path;
    return (
      app.metadataCache.getFirstLinkpathDest(target, row.file.path)?.path ?? null
    );
  };
  const cache = app.metadataCache.getFileCache(row.file);
  const file = {
    basename: row.file.basename,
    path: row.file.path,
    folder: row.file.parent?.path ?? "",
    mtime: row.file.stat.mtime,
    ctime: row.file.stat.ctime,
    size: row.file.stat.size,
    outlinks: buildOutlinks(
      cache?.links,
      cache?.embeds,
      row.file.path,
      resolveLink
    )
  };
  if (row.kind === "task") {
    return {
      file,
      resolveLink,
      task: {
        status: row.status,
        text: row.text,
        line: row.line,
        section: row.section
      }
    };
  }
  return { file, resolveLink, frontmatter: row.frontmatter };
}

/** 找到 line 之前最近的一个标题作为章节名。 */
function enclosingHeading(cache: CachedMetadata | null, line: number): string {
  let heading = "";
  for (const h of cache?.headings ?? []) {
    if (h.position.start.line > line) break;
    heading = h.heading;
  }
  return heading;
}

export class QueryManager {
  constructor(
    private readonly app: App,
    private readonly plugin: Plugin
  ) {}

  async onload(): Promise<void> {
    this.plugin.registerMarkdownCodeBlockProcessor("astra", (source, el) => {
      void this.process(source, el);
    });
  }

  onunload(): void {
    // registerMarkdownCodeBlockProcessor 随插件生命周期自动清理，无需额外处理
  }

  private async process(source: string, el: HTMLElement): Promise<void> {
    let query: Query;
    try {
      query = parseQuery(source);
    } catch (e) {
      this.renderError(el, e instanceof Error ? e.message : String(e));
      return;
    }

    // TASK 查询：行数据来自正文任务项，不走 frontmatter 管线
    if (query.type === "task") {
      const rows = this.applyClauses(await this.collectTasks(query.from), query);
      this.renderTask(el, rows);
      return;
    }

    const files = this.collectFiles(query.from);
    const loaded = await Promise.all(
      files.map(async (file): Promise<Row | null> => {
        try {
          const content = await this.app.vault.cachedRead(file);
          return {
            kind: "frontmatter",
            file,
            frontmatter: parseFrontmatter(content, file.path)
          };
        } catch {
          return null;
        }
      })
    );
    const rows = this.applyClauses(
      loaded.filter((r): r is Row => r !== null),
      query
    );

    // 按查询类型分发渲染
    if (query.type === "table") {
      await this.renderTable(el, query, rows);
    } else {
      this.renderList(el, query, rows);
    }
  }

  /** 子句执行管线：WHERE → SORT → LIMIT（顺序与 Dataview 一致）。 */
  private applyClauses<T extends QueryRow>(rows: T[], query: CommonClauses): T[] {
    let result = rows;
    if (query.where) {
      result = result.filter((row) =>
        evaluateWhere(rowContext(row, this.app), query.where!)
      );
    }

    if (query.sort) {
      const { field, desc } = query.sort;
      result = [...result].sort((a, b) => {
        const va = resolveFieldValue(rowContext(a, this.app), field);
        const vb = resolveFieldValue(rowContext(b, this.app), field);
        // 空值排最后
        const ea = isEmptyValue(va);
        const eb = isEmptyValue(vb);
        if (ea && !eb) return 1;
        if (eb && !ea) return -1;
        const cmp = compareValues(va, vb);
        return desc ? -cmp : cmp;
      });
    }

    if (query.limit) {
      result = result.slice(0, query.limit.count);
    }
    return result;
  }

  /** TASK 行数据：收集 FROM 源内所有正文任务项（- [ ] / - [x] 等）。
   * 位置信息取自官方 metadataCache（listItems），文本按行回读解析。 */
  private async collectTasks(from: FromSource | null): Promise<TaskRow[]> {
    const rows: TaskRow[] = [];
    for (const file of this.collectFiles(from)) {
      const cache = this.app.metadataCache.getFileCache(file);
      const taskItems =
        cache?.listItems?.filter((li) => li.task !== undefined) ?? [];
      if (taskItems.length === 0) continue;
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split(/\r?\n/);
      for (const li of taskItems) {
        const m = (lines[li.position.start.line] ?? "").match(
          /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/
        );
        if (!m) continue;
        rows.push({
          kind: "task",
          file,
          status: m[1]!,
          text: m[2]!.trim(),
          line: li.position.start.line,
          section: enclosingHeading(cache, li.position.start.line)
        });
      }
    }
    return rows;
  }

  private collectFiles(from: FromSource | null): TFile[] {
    if (from === null) {
      return this.app.vault.getMarkdownFiles();
    }
    if (from.kind === "tag") {
      // 标签源：无法按文件夹收窄，扫描全库按标签匹配
      return this.app.vault
        .getMarkdownFiles()
        .filter((file) => this.fileMatchesTag(file, from.tag));
    }
    const root = this.app.vault.getAbstractFileByPath(from.path);
    const files: TFile[] = [];
    const collect = (node: TAbstractFile): void => {
      if (node instanceof TFolder) {
        for (const child of node.children) {
          collect(child);
        }
      } else if (node instanceof TFile && node.name.endsWith(".md")) {
        files.push(node);
      }
    };
    if (root) {
      collect(root);
    }
    return files;
  }

  /** 标签匹配：正文内联标签（cache.tags）+ frontmatter 标签（官方 parseFrontMatterTags
   * 归一化，string/array/中英文逗号均可）；含子标签命中，大小写不敏感。 */
  private fileMatchesTag(file: TFile, tag: string): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) {
      return false;
    }
    const wanted = tag.toLowerCase();
    const tags = new Set<string>();
    for (const t of cache.tags ?? []) {
      tags.add(t.tag.replace(/^#/, "").toLowerCase());
    }
    for (const t of parseFrontMatterTags(cache.frontmatter) ?? []) {
      tags.add(t.replace(/^#/, "").toLowerCase());
    }
    for (const t of tags) {
      if (t === wanted || t.startsWith(wanted + "/")) {
        return true;
      }
    }
    return false;
  }

  private async renderTable(
    el: HTMLElement,
    query: TableQuery,
    rows: Row[]
  ): Promise<void> {
    const root = el.createDiv({ cls: "astra-query" });
    const table = root.createEl("table", { cls: "astra-query-table" });

    const count = rows.length;
    let fileCountShown = false;

    const headerRow = table.createEl("thead").createEl("tr");
    if (!query.withoutId) {
      fileCountShown = true;
      headerRow.createEl("th", { text: `File (${count})` });
    }
    for (const col of query.columns) {
      let text = col.alias ?? col.field;
      if (
        !fileCountShown &&
        col.expr.kind === "field" &&
        col.expr.field === "file.link"
      ) {
        text = `${text} (${count})`;
        fileCountShown = true;
      }
      headerRow.createEl("th", { text });
    }

    const body = table.createEl("tbody");
    for (const row of rows) {
      const tr = body.createEl("tr");
      if (!query.withoutId) {
        this.renderLink(
          tr.createEl("td", { cls: "astra-query-file-cell" }),
          row.file
        );
      }
      const ctx = rowContext(row, this.app);
      for (const col of query.columns) {
        const td = tr.createEl("td");
        if (col.expr.kind === "field" && col.expr.field === "file.link") {
          td.addClass("astra-query-file-cell");
          this.renderLink(td, row.file);
        } else {
          this.renderValue(td, evaluateExpression(ctx, col.expr), col.field);
        }
      }
    }
  }

  // LIST 渲染语义与 Dataview 一致：LIST → 仅文件链接；LIST 字段 → "链接: 值"；
  // LIST WITHOUT ID 字段 → 仅字段值
  private renderList(el: HTMLElement, query: ListQuery, rows: Row[]): void {
    const root = el.createDiv({ cls: "astra-query" });
    const ul = root.createEl("ul", { cls: "astra-query-list" });
    for (const row of rows) {
      const li = ul.createEl("li");
      if (query.format === null) {
        this.renderLink(li, row.file);
      } else if (query.withoutId) {
        this.renderValue(
          li,
          resolveFieldValue(rowContext(row, this.app), query.format),
          query.format
        );
      } else {
        this.renderLink(li, row.file);
        li.appendText(": ");
        this.renderValue(
          li,
          resolveFieldValue(rowContext(row, this.app), query.format),
          query.format
        );
      }
    }
  }

  // TASK 渲染：可勾选 checkbox + 任务文本，复用 Obsidian 原生 task-list-item 样式；
  // 悬停显示来源路径（对齐 Dataview 默认不在任务后追加文件链接的做法）。
  // 文本以纯文本渲染：经 MarkdownRenderer 会触发第三方 post-processor（见 renderLink 注释）。
  private renderTask(el: HTMLElement, rows: TaskRow[]): void {
    const root = el.createDiv({ cls: "astra-query" });
    const ul = root.createEl("ul", { cls: "astra-query-list astra-query-tasks" });
    for (const row of rows) {
      const li = ul.createEl("li", {
        cls: row.status === "x" ? "task-list-item is-checked" : "task-list-item",
        attr: { title: `${row.file.path}:${row.line + 1}` }
      });
      const box = li.createEl("input", {
        type: "checkbox",
        cls: "task-list-item-checkbox"
      });
      box.checked = row.status === "x";
      // 勾选写回：乐观锁校验失败时 writeTaskStatus 内部回滚 checked 并 inline 提示
      box.addEventListener("change", () => {
        void this.writeTaskStatus(row, box, li);
      });
      li.appendText(" " + row.text);
    }
  }

  /** TASK 勾选写回：vault.process 原子读改写；定位失败不落盘，checkbox 旁 inline 提示。 */
  private async writeTaskStatus(
    row: TaskRow,
    box: HTMLInputElement,
    li: HTMLElement
  ): Promise<void> {
    const targetDone = row.status !== "x";
    // holder 对象：闭包内的直接赋值不被 TS 控制流跟踪，
    // let + 字面量初始化会把成功分支窄化成 never
    const state: { outcome: WritebackResult } = {
      outcome: { ok: false, reason: "stale" }
    };
    try {
      await this.app.vault.process(row.file, (content) => {
        const eol = content.includes("\r\n") ? "\r\n" : "\n"; // 保留原换行风格
        const lines = content.split(/\r?\n/);
        const r = toggleTaskInLines(
          lines,
          { line: row.line, text: row.text },
          targetDone
        );
        state.outcome = r;
        return r.ok ? lines.join(eol) : content; // 失败原样返回 = 零写入
      });
    } catch {
      box.checked = !targetDone; // 回滚 UI
      this.showTaskHint(li, "dv.query.taskWriteFailed");
      return;
    }

    if (!state.outcome.ok) {
      box.checked = !targetDone;
      this.showTaskHint(
        li,
        state.outcome.reason === "ambiguous"
          ? "dv.query.taskAmbiguous"
          : "dv.query.taskStale"
      );
      return;
    }

    // 本地写即事实源：原地更新 UI，不等 metadataCache 事件，不做重扫描
    row.status = targetDone ? "x" : " ";
    row.line = state.outcome.line; // 行号漂移时同步快照
    li.classList.toggle("is-checked", targetDone);
  }

  /** checkbox 旁 inline 失败提示：5 秒自动消失，重复触发先移除旧的。 */
  private showTaskHint(li: HTMLElement, key: string): void {
    li.querySelector(".astra-query-task-hint")?.remove();
    const hint = li.createSpan({
      cls: "astra-query-task-hint",
      text: $t(key)
    });
    window.setTimeout(() => hint.remove(), 5000);
  }

  // 直接构造 <a class="internal-link"> DOM，不经过 MarkdownRenderer：
  // MarkdownRenderer 会嵌套触发全部全局 markdown post-processor，
  // 第三方插件（如 simple-mind-map 的嵌入预览接管）可能据此清空整个预览容器，
  // 而 Obsidian 对 internal-link 的点击/悬停预览都是全局委托，动态创建的元素同样生效（与 Dataview 做法一致）。
  private renderLink(el: HTMLElement, file: TFile): void {
    el.createEl("a", {
      cls: "internal-link",
      text: file.basename,
      attr: { "data-href": file.path, href: file.path }
    });
  }

  private renderValue(el: HTMLElement, value: unknown, field: string): void {
    if (value === null || value === undefined) {
      return;
    }
    el.setText(this.normalize(formatCellValue(field, value)));
  }

  /** 折叠所有连续空白（含换行）为单个空格，并去除首尾空白。 */
  private normalize(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private renderError(el: HTMLElement, message: string): void {
    el.createDiv({ cls: "astra-query-error" }).setText(
      `Astra 查询错误：${message}`
    );
  }
}