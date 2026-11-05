// ================= Astra 通用查询：DQL 子集解析器 =================
// 解析 ```astra 代码块里的查询语法（自研轻量引擎，无 Obsidian 依赖）。
// 结构参照 Dataview 的判别联合设计：查询头（TABLE / LIST / TASK）+ 共享子句
// （FROM / WHERE / SORT / LIMIT），每种查询头附带各自的载荷（TABLE = 列定义）。
// 当前实现 TABLE / LIST / TASK。
// 支持：TABLE [WITHOUT ID] 字段 [AS "别名"] ... FROM "路径"|#标签
//       [WHERE 条件] [SORT 字段 [ASC|DESC]] [LIMIT N]
//       LIST [WITHOUT ID] [字段]
// 表达式层支持字段名、带引号字符串、`[[wikilink]]` 与函数调用
// （dateformat / contains / startswith / endswith）；其他函数名会抛 QueryParseError，避免静默当作字段名查不到。

export type Expr =
  | { kind: "field"; field: string }
  | { kind: "literal"; value: string }
  | { kind: "wiki"; raw: string; target: string; subpath?: string }
  | { kind: "dateformat"; source: Expr; format: string }
  | { kind: "contains"; list: Expr; value: Expr }
  | { kind: "startswith"; value: Expr; prefix: Expr }
  | { kind: "endswith"; value: Expr; suffix: Expr };

export interface ColumnSpec {
  /** 原始字段/表达式文本：用于表头回退显示与 file.link 判定 */
  field: string;
  /** 解析后的表达式（字段名 / 字符串 / dateformat 调用） */
  expr: Expr;
  /** AS 后的别名，如 "描述"；无别名时为 undefined */
  alias?: string;
}

/** WHERE 的单条比较项。left/right 均为表达式，right 缺省用于 truthy/falsy。 */
export interface WhereTerm {
  kind: "term";
  left: Expr;
  op: "=" | "!=" | "truthy" | "falsy";
  right?: Expr;
}

/** WHERE 的条件组：同一层为纯 AND 或纯 OR，混合时 AND 优先（见 parseWhere）。 */
export interface WhereGroup {
  kind: "group";
  op: "and" | "or";
  terms: WhereSpec[];
}

export type WhereSpec = WhereTerm | WhereGroup;

export interface SortSpec {
  field: string;
  /** true = DESC，false = ASC（默认） */
  desc: boolean;
}

export interface LimitSpec {
  /** 最多返回的行数（非负整数） */
  count: number;
}

/** FROM 源：文件夹路径或标签（不含 # 前缀，匹配含子标签）。 */
export type FromSource =
  | { kind: "folder"; path: string }
  | { kind: "tag"; tag: string };

/** 所有查询类型共享的子句。 */
export interface CommonClauses {
  /** FROM 源；null = 整库 */
  from: FromSource | null;
  where: WhereSpec | null;
  sort: SortSpec | null;
  limit: LimitSpec | null;
}

/** TABLE 查询：渲染为 Dataview 风格表格。 */
export interface TableQuery extends CommonClauses {
  type: "table";
  /** 是否带 WITHOUT ID（去掉默认的文件链接列） */
  withoutId: boolean;
  /** 显式声明的列 */
  columns: ColumnSpec[];
}

/** LIST 查询：渲染为 Dataview 风格列表。 */
export interface ListQuery extends CommonClauses {
  type: "list";
  /** 是否带 WITHOUT ID（去掉默认的文件链接前缀） */
  withoutId: boolean;
  /** LIST 后的单一字段；null = 仅文件链接 */
  format: string | null;
}

/** TASK 查询：渲染正文任务项的只读列表。 */
export interface TaskQuery extends CommonClauses {
  type: "task";
}

/** 查询判别联合：按 type 字段分流到对应渲染器。 */
export type Query = TableQuery | ListQuery | TaskQuery;

export class QueryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryParseError";
  }
}

/** 是否被成对引号包裹（不校验内部转义，够 DQL 子集使用）。 */
function isQuoted(s: string): boolean {
  return (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  );
}

/** 去除首尾成对的双引号/单引号。 */
export function unquote(s: string): string {
  return isQuoted(s) ? s.slice(1, -1) : s;
}

/**
 * 按顶层分隔符切分：忽略 () 内部与引号内部的字符。
 * 例：`a(x, y), b` → ["a(x, y)", "b"]。括号不配对时按深度 0 兜底。
 */
export function splitTopLevel(text: string, sep = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && ch === sep) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_.#-]/.test(ch);
}

/** 按顶层 AND / OR 关键字切分；引号与括号内部的 AND/OR 不生效。 */
function splitByBoolean(text: string, keyword: "AND" | "OR"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (i > 0 && isWordChar(text[i - 1]!)) continue;
    if (text.slice(i, i + keyword.length).toUpperCase() !== keyword) continue;
    const after = text[i + keyword.length];
    if (after !== undefined && isWordChar(after)) continue;
    parts.push(text.slice(start, i).trim());
    i += keyword.length - 1;
    start = i + 1;
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** 找到顶层第一个比较运算符（!= 或 =），跳过引号与括号内部。 */
function findComparison(
  text: string
): { index: number; op: "=" | "!=" } | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (ch === "!" && text[i + 1] === "=") return { index: i, op: "!=" };
    if (ch === "=" && !/[!<>=]/.test(text[i - 1] ?? "")) {
      return { index: i, op: "=" };
    }
  }
  return null;
}

/** 在顶层找最后一个 AS 关键字（引号/括号内部的 AS 不算）。 */
function findTopLevelAs(text: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (i > 0 && isWordChar(text[i - 1]!)) continue;
    if (text.slice(i, i + 2).toUpperCase() !== "AS") continue;
    const after = text[i + 2];
    if (after !== undefined && isWordChar(after)) continue;
    found = i;
    i += 1;
  }
  return found;
}

/** 解析 `[[target#subpath|alias]]`：忽略 alias，保留 subpath（不参与路径比较）。 */
function parseWikiLink(s: string): Expr | null {
  const m = s.match(/^\[\[(.+)\]\]$/);
  if (!m) return null;
  const withoutAlias = m[1]!.split("|")[0]!;
  const parts = withoutAlias.split("#");
  const target = parts[0]!.trim();
  const subpath = parts.length > 1 ? parts.slice(1).join("#").trim() : undefined;
  return subpath
    ? { kind: "wiki", raw: s, target, subpath }
    : { kind: "wiki", raw: s, target };
}

/** 函数名 → 解析器（参数已按顶层逗号切分）。未知函数名一律报错。 */
const FUNCTION_PARSERS: Record<
  string,
  (args: string[], source: string) => Expr
> = {
  dateformat: (args, source) => {
    if (args.length !== 2 || !args[0] || !args[1]) {
      throw new QueryParseError("dateformat 需要两个参数：" + source);
    }
    if (!isQuoted(args[1])) {
      throw new QueryParseError(
        "dateformat 的格式参数必须是带引号的字符串：" + args[1]
      );
    }
    return {
      kind: "dateformat",
      source: parseExpression(args[0]),
      format: unquote(args[1])
    };
  },
  contains: (args, source) => {
    if (args.length !== 2 || !args[0] || !args[1]) {
      throw new QueryParseError("contains 需要两个参数：" + source);
    }
    return {
      kind: "contains",
      list: parseExpression(args[0]),
      value: parseExpression(args[1])
    };
  },
  startswith: (args, source) => {
    if (args.length !== 2 || !args[0] || !args[1]) {
      throw new QueryParseError("startswith 需要两个参数：" + source);
    }
    return {
      kind: "startswith",
      value: parseExpression(args[0]),
      prefix: parseExpression(args[1])
    };
  },
  endswith: (args, source) => {
    if (args.length !== 2 || !args[0] || !args[1]) {
      throw new QueryParseError("endswith 需要两个参数：" + source);
    }
    return {
      kind: "endswith",
      value: parseExpression(args[0]),
      suffix: parseExpression(args[1])
    };
  }
};

/** 解析字段/函数/wikilink 表达式。 */
export function parseExpression(text: string): Expr {
  const s = text.trim();
  if (!s) throw new QueryParseError("缺少字段表达式");

  const wiki = parseWikiLink(s);
  if (wiki) return wiki;

  const fn = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (fn) {
    const name = fn[1]!;
    const parse = FUNCTION_PARSERS[name];
    if (!parse) {
      throw new QueryParseError("不支持的函数：" + name);
    }
    if (!s.endsWith(")")) {
      throw new QueryParseError("函数调用缺少右括号：" + s);
    }
    const inner = s.slice(fn[0].length, -1);
    return parse(splitTopLevel(inner, ","), s);
  }

  if (s.includes("(")) throw new QueryParseError("无法解析表达式：" + s);
  if (isQuoted(s)) return { kind: "literal", value: unquote(s) };
  if (!/^[^\s,()]+$/.test(s)) throw new QueryParseError("无法解析字段：" + s);
  return { kind: "field", field: s };
}

/**
 * 解析单个列定义。
 * 别名支持两种形态：带引号（可含空格/逗号）或不带引号的单个 token；
 * 不带引号别名不允许空白/逗号/括号，避免把后续 `AND ...` 等非法内容吞进别名。
 */
export function parseColumn(spec: string): ColumnSpec {
  const raw = spec.trim();
  if (!raw) throw new QueryParseError("列定义为空");

  const asIndex = findTopLevelAs(raw);
  if (asIndex === -1) {
    return { field: raw, expr: parseExpression(raw) };
  }

  const fieldText = raw.slice(0, asIndex).trim();
  const aliasText = raw.slice(asIndex + 2).trim();
  let alias: string;
  if (isQuoted(aliasText)) {
    alias = unquote(aliasText);
  } else if (/^[^\s,()]+$/.test(aliasText)) {
    alias = aliasText;
  } else {
    throw new QueryParseError("无法解析列别名：" + aliasText);
  }
  if (!alias) throw new QueryParseError("AS 后缺少别名");
  return { field: fieldText, expr: parseExpression(fieldText), alias };
}

/** 解析单条 WHERE 比较项：`expr = value` / `expr != value` / `expr` / `!expr`。 */
export function parseWhereTerm(text: string): WhereTerm {
  const s = text.trim();
  if (!s) throw new QueryParseError("WHERE 条件为空");

  const cmp = findComparison(s);
  if (cmp) {
    const leftText = s.slice(0, cmp.index).trim();
    const rightText = s.slice(cmp.index + cmp.op.length).trim();
    if (!leftText) throw new QueryParseError("比较运算符左侧缺少字段");
    if (!rightText) throw new QueryParseError("比较运算符右侧缺少值");
    // 右值为函数调用或以 [[ 开头的 wikilink 时走表达式解析，否则按字面量
    const right =
      /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.test(rightText) ||
      rightText.startsWith("[[")
        ? parseExpression(rightText)
        : { kind: "literal" as const, value: unquote(rightText) };
    return {
      kind: "term",
      left: parseExpression(leftText),
      op: cmp.op,
      right
    };
  }

  if (s.startsWith("!")) {
    const expr = parseExpression(s.slice(1).trim());
    return { kind: "term", left: expr, op: "falsy" };
  }

  const expr = parseExpression(s);
  return { kind: "term", left: expr, op: "truthy" };
}

/**
 * 解析 WHERE 条件组。
 * 规则：先按顶层 OR 切分，再对每段按顶层 AND 切分 —— 即 AND 优先级高于 OR，
 * 例如 `a AND b OR c` 解析为 `(a AND b) OR c`。
 */
export function parseWhere(text: string): WhereSpec {
  const orParts = splitByBoolean(text, "OR");
  if (orParts.length > 1) {
    return { kind: "group", op: "or", terms: orParts.map(parseAndPart) };
  }
  return parseAndPart(text);
}

function parseAndPart(text: string): WhereSpec {
  const andParts = splitByBoolean(text, "AND");
  if (andParts.length > 1) {
    return { kind: "group", op: "and", terms: andParts.map(parseWhereTerm) };
  }
  return parseWhereTerm(text);
}

function parseSort(text: string): SortSpec {
  const m = text.match(/^(\S+)(?:\s+(ASC|DESC))?$/i);
  if (!m) {
    throw new QueryParseError("无法解析 SORT 子句：" + text);
  }
  return { field: m[1]!, desc: (m[2] || "").toUpperCase() === "DESC" };
}

function parseLimit(text: string): LimitSpec {
  const m = text.match(/^(\d+)$/);
  if (!m) {
    throw new QueryParseError("无法解析 LIMIT 子句：" + (text || "缺少行数"));
  }
  return { count: parseInt(m[1]!, 10) };
}

function parseFromSource(text: string): FromSource {
  if (!text) {
    throw new QueryParseError("FROM 后缺少路径或标签");
  }
  if (text.startsWith("#")) {
    const tag = text.slice(1).trim();
    if (!tag) {
      throw new QueryParseError("FROM 后缺少标签名");
    }
    return { kind: "tag", tag };
  }
  const path = unquote(text);
  if (!path) {
    throw new QueryParseError("FROM 后缺少路径");
  }
  return { kind: "folder", path };
}

/** 把 ```astra 代码块源码解析为结构化查询。 */
export function parseQuery(source: string): Query {
  const raw = source.trim();
  if (!raw) {
    throw new QueryParseError("查询内容为空");
  }

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 查询头：TABLE / LIST / TASK
  const headerMatch = lines[0]!.match(/^(TABLE|LIST|TASK)\b/i);
  if (!headerMatch) {
    throw new QueryParseError("查询必须以 TABLE / LIST / TASK 开头");
  }
  const kind = headerMatch[1]!.toLowerCase() as "table" | "list" | "task";

  // 查询头之后的剩余内容（可能紧跟着 WITHOUT ID 与列/字段定义）
  let rest = lines[0]!.slice(headerMatch[0].length).trim();
  let withoutId = false;
  const withoutIdMatch = rest.match(/^WITHOUT\s+ID\b/i);
  if (withoutIdMatch) {
    withoutId = true;
    rest = rest.slice(withoutIdMatch[0].length).trim();
  }

  // 内容行 = 第一行剩余列定义 + 后续所有行（FROM/WHERE/SORT 需行首）
  const contentLines: string[] = [];
  if (rest) {
    contentLines.push(rest);
  }
  for (let i = 1; i < lines.length; i++) {
    contentLines.push(lines[i]!);
  }

  const columnsText: string[] = [];
  let from: string | null = null;
  let where: string | null = null;
  let sort: string | null = null;
  let limit: string | null = null;

  for (const line of contentLines) {
    // WHERE 续行：缩进的 AND / OR 行并入上一个 WHERE 子句，而不是当成列定义
    if (where !== null && /^(AND|OR)\b/i.test(line)) {
      where = `${where} ${line}`;
      continue;
    }
    const fromM = line.match(/^FROM\b\s*(.*)$/i);
    const whereM = line.match(/^WHERE\b\s*(.*)$/i);
    const sortM = line.match(/^SORT\b\s*(.*)$/i);
    const limitM = line.match(/^LIMIT\b\s*(.*)$/i);
    if (fromM) {
      from = fromM[1]!.trim();
      continue;
    }
    if (whereM) {
      where = whereM[1]!.trim();
      continue;
    }
    if (sortM) {
      sort = sortM[1]!.trim();
      continue;
    }
    if (limitM) {
      limit = limitM[1]!.trim();
      continue;
    }
    columnsText.push(line);
  }

  const payloadStr = columnsText.join(" ").trim();

  // 注意用 !== null 判断：子句值为空串（如裸 "LIMIT" 行）时也必须走解析并报错
  const clauses = {
    from: from !== null ? parseFromSource(from) : null,
    where: where !== null ? parseWhere(where) : null,
    sort: sort !== null ? parseSort(sort) : null,
    limit: limit !== null ? parseLimit(limit) : null,
  };

  // LIST 载荷：可选的单个字段名（不支持 AS 别名）
  if (kind === "list") {
    if (payloadStr && !/^\S+$/.test(payloadStr)) {
      throw new QueryParseError("无法解析 LIST 字段：" + payloadStr);
    }
    return { type: "list", withoutId, format: payloadStr || null, ...clauses };
  }

  // TASK 载荷：无字段，也不支持 WITHOUT ID
  if (kind === "task") {
    if (withoutId) {
      throw new QueryParseError("TASK 不支持 WITHOUT ID");
    }
    if (payloadStr) {
      throw new QueryParseError("TASK 后不支持字段定义：" + payloadStr);
    }
    return { type: "task", ...clauses };
  }

  // TABLE 载荷：顶层逗号分隔的列定义（函数参数内的逗号不切分）
  if (!payloadStr) {
    throw new QueryParseError("TABLE 后缺少列定义");
  }
  const columns: ColumnSpec[] = splitTopLevel(payloadStr, ",")
    .filter((s) => s.length > 0)
    .map(parseColumn);

  if (columns.length === 0) {
    throw new QueryParseError("TABLE 后缺少列定义");
  }

  return { type: "table", withoutId, columns, ...clauses };
}
