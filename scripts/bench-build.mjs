import esbuild from "esbuild";
import process from "process";
import { mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import sveltePlugin from "esbuild-svelte";

/**
 * 生成带 metafile 的生产构建到 /tmp，输出体积构成 JSON
 * 运行：node scripts/bench-build.mjs
 */

const META_OUT = "/tmp/astra-build-meta.json";
const BUNDLE_OUT = "/tmp/astra-build.js";

const result = await esbuild.build({
  banner: { js: "/* bench */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2021",
  treeShaking: true,
  outfile: BUNDLE_OUT,
  minify: true,
  metafile: true,
  loader: { ".css": "text" },
  plugins: [
    sveltePlugin({ compilerOptions: { css: true } }),
  ],
  mainFields: ["svelte", "browser", "module", "main"],
});

writeFileSync(META_OUT, JSON.stringify(result.metafile));

const meta = JSON.parse(readFileSync(META_OUT, "utf-8"));

// 按顶层模块统计
const toplevel = {};
const detail = {};
for (const [outputPath, info] of Object.entries(meta.outputs)) {
  for (const [entry, reason] of Object.entries(info.inputs)) {
    let topKey;
    if (entry.startsWith("src/")) {
      const parts = entry.split("/");
      topKey = `src/${parts[1] || "(root)"}`;
    } else if (entry.startsWith("node_modules/")) {
      const parts = entry.split("/");
      topKey = parts[1].startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1];
    } else {
      topKey = "(other)";
    }
    toplevel[topKey] = (toplevel[topKey] || 0) + info.bytes;
    detail[entry] = { top: topKey, bytes: info.bytes };
  }
}

const total = statSync(BUNDLE_OUT).size;

const toplevelSorted = Object.entries(toplevel)
  .sort((a, b) => b[1] - a[1])
  .map(([name, bytes]) => ({ name, bytes, pct: ((bytes / total) * 100).toFixed(1) }));

const top15 = Object.entries(detail)
  .sort((a, b) => b[1].bytes - a[1].bytes)
  .slice(0, 15)
  .map(([name, info]) => ({ name, bytes: info.bytes, top: info.top, pct: ((info.bytes / total) * 100).toFixed(1) }));

console.log(`=== BUILD SIZE: ${(total / 1024).toFixed(1)} KB ===`);
console.log("");
console.log("--- Top-level modules ---");
for (const t of toplevelSorted) {
  console.log(`  ${t.pct.padStart(5)}%  ${(t.bytes / 1024).toFixed(1).padStart(8)} KB  ${t.name}`);
}
console.log("");
console.log("--- Top 15 detailed ---");
for (const d of top15) {
  console.log(`  ${d.pct.padStart(5)}%  ${(d.bytes / 1024).toFixed(1).padStart(8)} KB  ${d.name}`);
}

// 与现有 dist 对照
try {
  const distMain = statSync("dist/main.js").size;
  const distCSS = statSync("dist/styles.css").size;
  console.log("");
  console.log("--- Current dist/ ---");
  console.log(`  dist/main.js:  ${(distMain / 1024).toFixed(1)} KB`);
  console.log(`  dist/styles.css: ${(distCSS / 1024).toFixed(1)} KB`);
  console.log(`  dist total:    ${((distMain + distCSS) / 1024).toFixed(1)} KB`);
} catch {}

// 写 JSON 报告
const report = { totalBytes: total, totalKB: (total / 1024).toFixed(1), toplevel: toplevelSorted, top15 };
writeFileSync("/tmp/astra-build-report.json", JSON.stringify(report, null, 2));
