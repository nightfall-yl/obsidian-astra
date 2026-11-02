/**
 * 纯函数级基准（Node + tsx，不新增依赖，不走 Obsidian runtime）
 * 运行：cd 项目根 && npx tsx scripts/bench-functions.ts
 */
import { performance } from "node:perf_hooks";
import MiniSearch from "minisearch";
import { DateTime } from "luxon";
import { parse } from "yaml";

// === Bench 1: YAML frontmatter 解析（纯 yaml 库，不依赖 Obsidian runtime） ===
console.log("=".repeat(60));
console.log("BENCH 1: YAML frontmatter parse (2000 files)");
console.log("=".repeat(60));

const N_FILES = 2000;
const YAML_BLOCKS: string[] = [];
for (let i = 0; i < N_FILES; i++) {
  const fm = `project: 项目 Alpha-${i}
priority: ${["high","medium","low"][i%3]}
status: ${["todo","doing","done"][i%3]}
tags: [task, project, ${i % 5 === 0 ? "urgent" : "normal"}]
due: 2026-1${(i%9)+1}-${String((i%28)+1).padStart(2,'0')}
`;
  YAML_BLOCKS.push(fm);
}

// warmup
for (const block of YAML_BLOCKS.slice(0, 20)) parse(block);

const t0 = performance.now();
let parsedCount = 0;
for (const block of YAML_BLOCKS) {
  const result = parse(block);
  if (result && typeof result === "object") parsedCount++;
}
const t1 = performance.now();
console.log(`  parseYaml  ${N_FILES} blocks: ${(t1 - t0).toFixed(2)} ms  (${parsedCount} OK)`);
console.log(`  per file:  ${((t1 - t0) / N_FILES * 1000).toFixed(2)} µs`);

// === Bench 2: MiniSearch 建索引 + 查询 ===
console.log("");
console.log("=".repeat(60));
console.log("BENCH 2: MiniSearch (2000 docs CJK mixed, English tokenizer)");
console.log("=".repeat(60));

const N_DOCS = 2000;
const QUERIES = ["report", "meeting", "plan", "review", "project", "task", "project report", "important daily"];
const EN_WORDS = ["project", "report", "meeting", "plan", "review", "todo", "important", "daily", "weekly", "quarter", "slide", "presentation", "notes", "idea", "task"];

const docs: { id: string; path: string; title: string; content: string }[] = [];
for (let i = 0; i < N_DOCS; i++) {
  const enTitle = EN_WORDS[Math.floor(Math.random() * EN_WORDS.length)];
  const enBody = Array.from({ length: 40 }, () => EN_WORDS[Math.floor(Math.random() * EN_WORDS.length)]).join(" ");
  docs.push({
    id: "note-" + i,
    path: "/vault/note-" + i + ".md",
    title: `${enTitle} #${i}`,
    content: `${enBody}\n\nThis is synthetic document ${i} for benchmark testing the search index performance with mixed English and placeholder text to simulate realistic note content volume.`,
  });
}

const t2 = performance.now();
const mini = new MiniSearch({
  fields: ["title", "content"],
  storeFields: ["title", "path"],
  searchOptions: { boost: { title: 2 } },
});
mini.addAll(docs);
const t3 = performance.now();
console.log(`  build-index  ${N_DOCS} docs: ${(t3 - t2).toFixed(2)} ms`);

// 20 次查询
let totalResults = 0;
const t4 = performance.now();
for (let r = 0; r < 2; r++) {
  for (const q of QUERIES) {
    const res = mini.search(q, { limit: 10 });
    totalResults += res.length;
  }
}
const t5 = performance.now();
const avgQ = ((t5 - t4) / (QUERIES.length * 2)).toFixed(3);
console.log(`  query-latency  avg ${avgQ} ms/query (over 20 queries, ${totalResults} total hits)`);

// 增量更新
const t6 = performance.now();
for (let i = 0; i < 10; i++) {
  const idx = Math.floor(Math.random() * N_DOCS);
  mini.replace({ ...docs[idx], title: docs[idx].title + " [edited]" });
}
const t7 = performance.now();
console.log(`  incremental-update  10 docs: ${(t7 - t6).toFixed(2)} ms`);

// === Bench 3: Heatmap grid generation (GitHub-style 365 days) ===
console.log("");
console.log("=".repeat(60));
console.log("BENCH 3: Heatmap grid + color mapping (365 days × 1000 iters)");
console.log("=".repeat(60));

const YEAR = DateTime.now().year;
const ITER = 1000;

// 365 天频率数据
const dates: Record<string, number> = {};
for (let m = 1; m <= 12; m++) {
  for (let d = 1; d <= 28; d++) {
    const key = `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    dates[key] = Math.floor(Math.random() * 7);
  }
}

// 生成 GitHub-style 52×7 grid
const t8 = performance.now();
for (let iter = 0; iter < ITER; iter++) {
  const startOfYear = DateTime.local(YEAR, 1, 1);
  const startWeekday = startOfYear.weekday; // 1 (Mon) .. 7 (Sun)
  const offset = startWeekday === 7 ? 0 : startWeekday; // Sun=0
  const totalCells = offset + 365 + ((7 - ((offset + 365) % 7)) % 7);
  const weeks = Math.ceil(totalCells / 7);
  const grid: number[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: number[] = [];
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d - offset;
      const dateKey = startOfYear.plus({ days: idx }).toFormat("yyyy-MM-dd");
      col.push(dates[dateKey] ?? 0);
    }
    grid.push(col);
  }
}
const t9 = performance.now();
console.log(`  heatmap-grid  ${ITER} iters: ${(t9 - t8).toFixed(2)} ms  (${((t9 - t8) / ITER * 1000).toFixed(3)} ms/iter)`);

// Color mapping (palette lookup)
const palette = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
const t10 = performance.now();
for (let iter = 0; iter < ITER * 5; iter++) {
  for (let w = 0; w < 54; w++) {
    for (let d = 0; d < 7; d++) {
      const val = Math.floor(Math.random() * 7);
      const color = palette[Math.min(val, palette.length - 1)];
    }
  }
}
const t11 = performance.now();
console.log(`  color-map  378 cells × ${ITER * 5} iters: ${(t11 - t10).toFixed(2)} ms  (${((t11 - t10) / (ITER * 5)).toFixed(3)} ms/iter)`);

// === Bench 4: Task writeback row locate (模拟) ===
console.log("");
console.log("=".repeat(60));
console.log("BENCH 4: Task writeback row locate (40 tasks × 1000 iters, ±5 window)");
console.log("=".repeat(60));

const WINDOW = 5;
const FILE_LINES = 400;
const TASK_COUNT = 40;

function locateLine(lines: string[], targetTaskText: string, snapshotRow: number, windowSize: number): number {
  const norm = (s: string) => s.trim().replace(/^[-*+] \[[xX ]\] /, "");
  const directIdx = snapshotRow - 1;
  if (directIdx >= 0 && directIdx < lines.length && norm(lines[directIdx]) === norm(targetTaskText)) {
    return snapshotRow;
  }
  for (let offset = 1; offset <= windowSize; offset++) {
    for (const dir of [-1, 1]) {
      const idx = directIdx + offset * dir;
      if (idx >= 0 && idx < lines.length && norm(lines[idx]) === norm(targetTaskText)) {
        return idx + 1;
      }
    }
  }
  return -1;
}

// 模拟 400 行任务文件
const fileLines: string[] = [];
for (let i = 0; i < FILE_LINES; i++) {
  if (i % 10 === 0 && i > 0) {
    fileLines.push(`- [ ] 任务 ${Math.floor(i / 10)}: 完成季度报告 PPT 并提交审阅 #task`);
  } else {
    fileLines.push(`正文段落 ${i}: 这里是笔记正文，增加文件体积让定位更真实。`);
  }
}

const tasks: { lineNo: number; text: string }[] = [];
for (let i = 0; i < TASK_COUNT; i++) {
  const lineNo = (i + 1) * 10;
  tasks.push({ lineNo, text: fileLines[lineNo - 1] });
}

const ITER_LOCATE = 1000;
let success = 0, fail = 0;

const t12 = performance.now();
for (let it = 0; it < ITER_LOCATE; it++) {
  for (const task of tasks) {
    const drift = Math.random() < 0.1 ? Math.floor(Math.random() * 5) - 2 : 0;
    const result = locateLine(fileLines, task.text, task.lineNo + drift, WINDOW);
    if (result > 0) success++;
    else fail++;
  }
}
const t13 = performance.now();

console.log(`  locate  ${TASK_COUNT} tasks × ${ITER_LOCATE} iters: ${(t13 - t12).toFixed(2)} ms`);
console.log(`  success: ${success}  fail: ${fail}  fail-rate: ${(fail / (TASK_COUNT * ITER_LOCATE) * 100).toFixed(2)}%`);
console.log(`  per locate: ${((t13 - t12) / (TASK_COUNT * ITER_LOCATE) * 1000).toFixed(3)} µs`);

console.log("");
console.log("(pure benchmarks complete — no Obsidian runtime needed)");
