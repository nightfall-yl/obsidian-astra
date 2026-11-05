// ================= Astra 查询：表达式求值与排序比较（纯函数，无 Obsidian 依赖） =================
// 供 manager.ts 组装行上下文后调用；单独抽出以便 vitest 直接覆盖。

import type { Expr, WhereSpec } from "./parser";

/** 文件元数据（与 TFile.stat 对应的只读子集）。 */
export interface FileMeta {
  basename: string;
  path: string;
  folder: string;
  mtime: number;
  ctime: number;
  size: number;
  /** 已解析目标路径（含 embed，解析失败已丢弃，同一目标去重） */
  outlinks: string[];
}

export interface TaskFields {
  status: string;
  text: string;
  line: number;
  section: string;
}

/** 一行可求值的上下文：文件元数据 + frontmatter（frontmatter 行）或任务字段（TASK 行）。 */
export interface FieldContext {
  file: FileMeta;
  frontmatter?: Record<string, unknown>;
  task?: TaskFields;
  /** wikilink 目标 → 已解析路径；返回 null 表示无法解析。缺省时退回原始文本。 */
  resolveLink?: (target: string) => string | null;
}

/** 字段值 → 字符串（对象转 JSON，避免显示 [object Object]；null/undefined 转空串）。 */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}

/** 内置字段 + frontmatter / 任务字段取值。 */
export function resolveFieldValue(
  ctx: FieldContext,
  field: string
): unknown {
  const { file } = ctx;
  if (ctx.task) {
    switch (field) {
      case "text":
        return ctx.task.text;
      case "completed":
        return ctx.task.status === "x";
      case "status":
        return ctx.task.status;
      case "line":
        return ctx.task.line;
      case "section":
        return ctx.task.section;
      case "path":
        return file.path;
      default:
        break;
    }
  }
  switch (field) {
    case "file.name":
      return file.basename;
    case "file.path":
      return file.path;
    case "file.folder":
      return file.folder;
    case "file.link":
      return file.basename;
    case "file.mtime":
      return file.mtime;
    case "file.ctime":
      return file.ctime;
    case "file.size":
      return file.size;
    case "file.outlinks":
      return file.outlinks;
    default:
      return ctx.frontmatter && field in ctx.frontmatter
        ? ctx.frontmatter[field]
        : null;
  }
}

const pad = (n: number, len: number): string => String(n).padStart(len, "0");

/** Moment/Luxon 风格的常见占位符 → 本地时间格式化。 */
export function formatDate(value: number | Date, format: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const tokens: Array<[string, (date: Date) => string]> = [
    ["yyyy", (x) => pad(x.getFullYear(), 4)],
    ["sss", (x) => pad(x.getMilliseconds(), 3)],
    ["HH", (x) => pad(x.getHours(), 2)],
    ["hh", (x) => pad(x.getHours() % 12 || 12, 2)],
    ["MM", (x) => pad(x.getMonth() + 1, 2)],
    ["dd", (x) => pad(x.getDate(), 2)],
    ["mm", (x) => pad(x.getMinutes(), 2)],
    ["ss", (x) => pad(x.getSeconds(), 2)],
    ["M", (x) => String(x.getMonth() + 1)],
    ["d", (x) => String(x.getDate())],
    ["H", (x) => String(x.getHours())],
    ["h", (x) => String(x.getHours() % 12 || 12)],
    ["m", (x) => String(x.getMinutes())],
    ["s", (x) => String(x.getSeconds())]
  ];

  let out = "";
  for (let i = 0; i < format.length; ) {
    let matched = false;
    for (const [token, render] of tokens) {
      if (format.startsWith(token, i)) {
        out += render(d);
        i += token.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += format[i]!;
      i += 1;
    }
  }
  return out;
}

/**
 * startswith / endswith 共用实现：两侧求值后 stringifyValue，再交给具体比较。
 * 左侧 null/undefined 或数组、右侧 null/undefined 一律返回 false。
 */
function evaluateAffix(
  ctx: FieldContext,
  valueExpr: Expr,
  affixExpr: Expr,
  test: (value: string, affix: string) => boolean
): boolean {
  const value = evaluateExpression(ctx, valueExpr);
  if (value === null || value === undefined || Array.isArray(value)) {
    return false;
  }
  const affix = evaluateExpression(ctx, affixExpr);
  if (affix === null || affix === undefined) return false;
  return test(stringifyValue(value), stringifyValue(affix));
}

/** 求值表达式：字段 / 字符串字面量 / wikilink / dateformat / contains / startswith / endswith。 */
export function evaluateExpression(ctx: FieldContext, expr: Expr): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "field":
      return resolveFieldValue(ctx, expr.field);
    case "wiki": {
      // 与 file.outlinks 保持同一口径：统一解析为路径字符串；无法解析时退回原文
      const resolved = ctx.resolveLink?.(expr.target);
      return resolved === null || resolved === undefined ? expr.target : resolved;
    }
    case "dateformat": {
      const value = evaluateExpression(ctx, expr.source);
      if (value === null || value === undefined) return null;
      if (value instanceof Date) return formatDate(value, expr.format);
      if (typeof value === "number") return formatDate(value, expr.format);
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? value : formatDate(parsed, expr.format);
      }
      return null;
    }
    case "contains": {
      const list = evaluateExpression(ctx, expr.list);
      if (!Array.isArray(list)) return false;
      const needle = stringifyValue(evaluateExpression(ctx, expr.value));
      return list.some((item) => stringifyValue(item) === needle);
    }
    case "startswith":
      // 区分大小写的严格前缀比较
      return evaluateAffix(ctx, expr.value, expr.prefix, (value, affix) =>
        value.startsWith(affix)
      );
    case "endswith":
      // 区分大小写的严格后缀比较
      return evaluateAffix(ctx, expr.value, expr.suffix, (value, affix) =>
        value.endsWith(affix)
      );
  }
}

/** 求值 WHERE 条件组（AND / OR 递归）。 */
export function evaluateWhere(ctx: FieldContext, spec: WhereSpec): boolean {
  if (spec.kind === "group") {
    return spec.op === "and"
      ? spec.terms.every((term) => evaluateWhere(ctx, term))
      : spec.terms.some((term) => evaluateWhere(ctx, term));
  }
  const left = evaluateExpression(ctx, spec.left);
  if (spec.op === "truthy") return !!left;
  if (spec.op === "falsy") return !left;
  const right = spec.right ? evaluateExpression(ctx, spec.right) : undefined;
  const a = stringifyValue(left);
  const b = stringifyValue(right);
  return spec.op === "=" ? a === b : a !== b;
}

/** 空值判定（null/undefined/空串/空数组）。 */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** 排序比较：两侧都是 number 时按数值比较，其余按字符串 localeCompare。 */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return stringifyValue(a).localeCompare(stringifyValue(b));
}

/** 单元格展示：file.mtime / file.ctime 的裸毫秒数默认格式化为可读时间。 */
export function formatCellValue(field: string, value: unknown): string {
  if (
    typeof value === "number" &&
    (field === "file.mtime" || field === "file.ctime")
  ) {
    return formatDate(value, "yyyy-MM-dd HH:mm");
  }
  if (Array.isArray(value)) {
    return value.map((v) => stringifyValue(v)).join(", ");
  }
  return stringifyValue(value);
}
