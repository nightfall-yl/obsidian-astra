/**
 * 纯函数级基准 — 用 vitest bench 或 node:process 计时
 * 注意：search-core / tokenizer 可能需要 synthetic test fixtures，不依赖 Obsidian runtime
 * 运行：node --experimental-strip-types scripts/bench-functions.ts
 *      （或用 npx tsx scripts/bench-functions.ts）
 */

// 用原生 perf_hooks 计时，避免引入新依赖
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// 先检查 tsx 是否可用
let runTs: ((file: string) => void) | null = null;
if (existsSync("node_modules/.bin/tsx")) {
  runTs = (file: string) => {
    const t0 = performance.now();
    execSync(`node_modules/.bin/tsx "${file}"`, { stdio: "inherit" });
    return performance.now() - t0;
  };
} else {
  console.log("❌ tsx not installed; run: npm install -D tsx");
  process.exit(1);
}

// === 生成临时测试代码 ===
const BENCH_TMP = mkdtempSync(`${tmpdir()}/astra-bench-`);
const mkPath = (name: string) => `${BENCH_TMP}/${name}`;

// ---- Bench 1: 任务解析 ----
const taskBench = `
import { parseYaml } from "obsidian";
import { taskFromFm } from "${process.cwd()}/src/data/taskParseCore";
import type { TaskItem } from "${process.cwd()}/src/data/taskParseCore";

const N = 2000;
const files = [];
for (let i = 0; i < N; i++) {
  const title = \`任务 \${i} - 完成季度报告的 PPT 并提交给领导审阅\`.slice(0, 20 + (i % 40));
  const fm = \`---\\nproject: 项目 Alpha\\npriority: \${["high","medium","low"][i%3]}\\nstatus: \${["todo","doing","done"][i%3]}\\ndue: 2026-1\${(i%9)+1}-\${(i%28)+1}\\n---\\n# \${title}\\n\`;
  files.push({ title, fm });
}

// 同时测 parseYaml 独立开销 和 完整 taskFromFm
const t0 = performance.now();
let yamlCount = 0;
for (const f of files) {
  const lines = f.fm.split(/\\r?\\n/);
  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') { end = i; break; }
    }
    if (end > 0) {
      const yamlBlock = lines.slice(1, end).join('\\n');
      const parsed = parseYaml(yamlBlock);
      if (parsed) yamlCount++;
    }
  }
}
const t1 = performance.now();
console.log(\`task-parseYaml  \${N} files: \${(t1-t0).toFixed(2)} ms  (\${yamlCount} parsed)\`);
`;

// ---- Bench 2: 搜索 MiniSearch 建索引 + 查询 ----
const searchBench = `
import MiniSearch from "minisearch";

const N_DOCS = 2000;
const QUERIES = ["报告", "project", "重要", "会议", "计划", "季度", "PPT", "review", "todo", "项目"];

// 生成中英混合合成语料
const EN_WORDS = ["project", "report", "meeting", "plan", "review", "todo", "important", "daily", "weekly", "quarter", "slide", "presentation", "notes", "idea", "task"];
const CN_WORDS = ["项目", "报告", "会议", "计划", "审阅", "重要", "每日", "每周", "季度", "幻灯片", "演示", "笔记", "想法", "任务", "截止"];

const docs = [];
for (let i = 0; i < N_DOCS; i++) {
  const enTitle = EN_WORDS[Math.floor(Math.random()*EN_WORDS.length)];
  const cnTitle = CN_WORDS[Math.floor(Math.random()*CN_WORDS.length)];
  const enBody = Array.from({length: 40}, () => EN_WORDS[Math.floor(Math.random()*EN_WORDS.length)]).join(' ');
  const cnBody = Array.from({length: 40}, () => CN_WORDS[Math.floor(Math.random()*CN_WORDS.length)]).join(' ');
  docs.push({
    id: "note-" + i,
    path: "/vault/note-" + i + ".md",
    title: \`\${enTitle} \${cnTitle} #\${i}\`,
    content: \`\${enBody}\\n\\n\${cnBody}\\n\\n这是第 \${i} 篇合成文档的正文，用于测试搜索性能。\`,
  });
}

// 建索引（使用 English tokenizer，不引入 Astra 的中文分词以避免 runtime 依赖）
const t0 = performance.now();
const mini = new MiniSearch({
  fields: ['title', 'content'],
  storeFields: ['title', 'path'],
  searchOptions: { boost: { title: 2 } },
});
mini.addAll(docs);
const t1 = performance.now();
console.log(\`search-index-build  \${N_DOCS} docs: \${(t1-t0).toFixed(2)} ms\`);

// 20 次查询（每种 query 各 2 次）
let totalResults = 0;
const t2 = performance.now();
for (let r = 0; r < 2; r++) {
  for (const q of QUERIES) {
    const res = mini.search(q, { limit: 10 });
    totalResults += res.length;
  }
}
const t3 = performance.now();
const avgQ = (t3 - t2) / (QUERIES.length * 2);
console.log(\`search-query-latency  avg over 20 queries: \${avgQ.toFixed(2)} ms/query  total results: \${totalResults}\`);

// 增量更新：随机修改 10 个文档并 update
const t4 = performance.now();
for (let i = 0; i < 10; i++) {
  const idx = Math.floor(Math.random() * N_DOCS);
  mini.replace({ ...docs[idx], title: docs[idx].title + " [edited]" });
}
const t5 = performance.now();
console.log(\`search-incremental-update  10 docs: \${(t5-t4).toFixed(2)} ms\`);
`;

// ---- Bench 3: Luxon date parsing / heatmap skeleton ----
const heatmapBench = `
import { DateTime } from "luxon";

const ITERATIONS = 1000;

// 生成 365 天数据
const year = DateTime.now().year;
const dates: Record<string, number> = {};
for (let m = 1; m <= 12; m++) {
  for (let d = 1; d <= 28; d++) {
    const key = \`\${year}-\${String(m).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`;
    dates[key] = Math.floor(Math.random() * 7); // 0-6 次写作
  }
}

// Benchmark: 生成 heatmap grid（与 dashboard view 逻辑相似）
const t0 = performance.now();
for (let iter = 0; iter < ITERATIONS; iter++) {
  const startOfYear = DateTime.local(year, 1, 1);
  const startWeekday = startOfYear.weekday; // 1..7 (Mon=1)
  // GitHub-style: 周日为第 0 列；转换 ISO weekday (1=Mon..7=Sun) → Sun=0..Sat=6
  const offset = startWeekday === 7 ? 0 : startWeekday;
  const totalCells = offset + 365 + (7 - ((offset + 365) % 7));
  const weeks = Math.ceil(totalCells / 7);
  const grid: number[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: number[] = [];
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d - offset;
      const dateKey = DateTime.local(year, 1, 1).plus({ days: idx }).toFormat('yyyy-MM-dd');
      col.push(dates[dateKey] ?? 0);
    }
    grid.push(col);
  }
}
const t1 = performance.now();
console.log(\`heatmap-grid  365 days × \${ITERATIONS} iters: \${(t1-t0).toFixed(2)} ms  (\${((t1-t0)/ITERATIONS).toFixed(3)} ms/iter)\`);

// Benchmark: color mapping (GitHub green palette)
const palette = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
const t2 = performance.now();
for (let iter = 0; iter < ITERATIONS * 3; iter++) {
  for (let w = 0; w < 54; w++) {
    for (let d = 0; d < 7; d++) {
      const val = Math.floor(Math.random() * 7);
      const color = palette[Math.min(val, palette.length - 1)];
    }
  }
}
const t3 = performance.now();
console.log(\`heatmap-color-map  378 cells × \${ITERATIONS*3} iters: \${(t3-t2).toFixed(2)} ms  (\${((t3-t2)/(ITERATIONS*3)).toFixed(3)} ms/iter)\`);
`;

// ---- Bench 4: Task writeback row location (模拟) ----
// 因为 taskWriteback 依赖 Obsidian metadataCache，我们只测 "纯行定位逻辑"
// —— 即给定任务文本，在 ±5 行窗口内扫描定位
const writebackBench = `
// 模拟 taskWriteback 的行定位逻辑：
// 快照行号漂移 ±5 行窗口，按任务文本唯一定位
const WINDOW = 5;
const SIMULATED_FILE_LINES = 400;
const SIMULATED_TASK_COUNT = 40;

function simulateTaskFile() {
  const lines = [];
  for (let i = 0; i < SIMULATED_FILE_LINES; i++) {
    if (i < 10) {
      lines.push(\`# 项目 Alpha\`);
    } else if (i % 10 === 0) {
      lines.push(\`- [ ] 任务 \${Math.floor(i/10)}: 完成季度报告 PPT 并提交审阅 #task\`);
    } else {
      lines.push(\`正文段落 \${i}: 这里是笔记的正文内容，用来增加文件体积，让定位变得更真实。\`);
    }
  }
  return lines;
}

function locateLine(lines: string[], targetTaskText: string, snapshotRow: number, windowSize: number): number {
  // 纯函数定位：先试 snapshotRow，如果不匹配在 ±windowSize 内扫描
  const norm = (s: string) => s.trim().replace(/^[-*] \[[xX ]\] /, '');
  const directIdx = snapshotRow - 1;
  if (directIdx >= 0 && directIdx < lines.length && norm(lines[directIdx]) === norm(targetTaskText)) {
    return snapshotRow;
  }
  // 扫描窗口
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

const file = simulateTaskFile();
const tasks = [];
for (let i = 0; i < SIMULATED_TASK_COUNT; i++) {
  const lineNo = (i + 1) * 10;
  tasks.push({ lineNo, text: file[lineNo - 1] });
}

const ITER = 1000;
let success = 0, fail = 0;

const t0 = performance.now();
for (let it = 0; it < ITER; it++) {
  for (const t of tasks) {
    // 模拟 10% 的行号漂移（随机 ±2 行）
    const drift = Math.random() < 0.1 ? Math.floor(Math.random() * 5) - 2 : 0;
    const result = locateLine(file, t.text, t.lineNo + drift, WINDOW);
    if (result > 0) success++; else fail++;
  }
}
const t1 = performance.now();

console.log(\`task-writeback-locate  \${SIMULATED_TASK_COUNT} tasks × \${ITER} iters: \${(t1-t0).toFixed(2)} ms\`);
console.log(\`  success: \${success}  fail: \${fail}  (\${fail / (SIMULATED_TASK_COUNT * ITER) * 100}% fail rate)\`);
`;

writeFileSync(mkPath("task.ts"), taskBench);
writeFileSync(mkPath("search.ts"), searchBench);
writeFileSync(mkPath("heatmap.ts"), heatmapBench);
writeFileSync(mkPath("writeback.ts"), writebackBench);

console.log("=== Benchmarks (running...) ===");
console.log("");

for (const [label, file] of [
  ["Task parsing", "task.ts"],
  ["Search", "search.ts"],
  ["Heatmap", "heatmap.ts"],
  ["Writeback locate", "writeback.ts"],
]) {
  try {
    runTs(mkPath(file));
  } catch (e) {
    console.log(`❌ ${label}: ${e.message || e}`);
  }
  console.log("");
}

// 清理临时目录
rmSync(BENCH_TMP, { recursive: true, force: true });
console.log("(temp dir cleaned)");
