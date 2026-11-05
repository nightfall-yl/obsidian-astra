import { describe, expect, it } from "vitest";
import {
  parseColumn,
  parseExpression,
  parseQuery,
  parseWhere,
  splitTopLevel,
  QueryParseError,
  type Expr,
  type ListQuery,
  type Query,
  type TableQuery,
  type WhereSpec,
} from "./parser";

/** 断言为 TABLE 查询并收窄类型，便于访问类型特定字段。 */
function asTable(q: Query): TableQuery {
  expect(q.type).toBe("table");
  return q as TableQuery;
}

/** 断言为 LIST 查询并收窄类型。 */
function asList(q: Query): ListQuery {
  expect(q.type).toBe("list");
  return q as ListQuery;
}

const fieldExpr = (field: string): Expr => ({ kind: "field", field });
const literalExpr = (value: string): Expr => ({ kind: "literal", value });
const col = (field: string, alias?: string): ReturnType<typeof parseColumn> =>
  alias
    ? { field, alias, expr: fieldExpr(field) }
    : { field, expr: fieldExpr(field) };

const termOf = (
  left: Expr,
  op: "=" | "!=" | "truthy" | "falsy",
  right?: Expr
): WhereSpec => (right ? { kind: "term", left, op, right } : { kind: "term", left, op });

describe("splitTopLevel", () => {
  it("按顶层逗号切分，忽略引号与括号内部", () => {
    expect(splitTopLevel('dateformat(file.mtime, "yyyy-MM-dd HH:mm"), a.b')).toEqual([
      'dateformat(file.mtime, "yyyy-MM-dd HH:mm")',
      "a.b",
    ]);
    expect(splitTopLevel('"a, b", c')).toEqual(['"a, b"', "c"]);
  });

  it("保留嵌套括号与空段过滤职责由调用方处理", () => {
    expect(splitTopLevel("f(g(1, 2), 3), x")).toEqual(["f(g(1, 2), 3)", "x"]);
    expect(splitTopLevel("a,   b", ",")).toEqual(["a", "b"]);
  });
});

describe("parseColumn", () => {
  it("接受不带引号的单个 token 别名", () => {
    expect(parseColumn("file.folder AS 位置")).toEqual({
      ...col("file.folder", "位置"),
    });
  });

  it("接受带引号别名（可含空格）", () => {
    expect(parseColumn('file.mtime AS "修改 时间"')).toEqual({
      ...col("file.mtime", "修改 时间"),
    });
  });

  it("别名不吞后续内容：AS 后带 AND 等非法文本会抛错", () => {
    expect(() =>
      parseColumn('file.mtime AS 修改时间 AND file.name != "x"')
    ).toThrow(QueryParseError);
    expect(() => parseColumn("file.mtime AS 修改 时间")).toThrow(
      QueryParseError
    );
    expect(() => parseColumn("file.mtime AS")).toThrow(QueryParseError);
  });

  it("解析 dateformat 函数列", () => {
    expect(parseColumn('dateformat(file.mtime, "yyyy-MM-dd HH:mm") AS "修改时间"')).toEqual({
      field: 'dateformat(file.mtime, "yyyy-MM-dd HH:mm")',
      alias: "修改时间",
      expr: {
        kind: "dateformat",
        source: fieldExpr("file.mtime"),
        format: "yyyy-MM-dd HH:mm",
      },
    });
  });
});

describe("parseExpression：wikilink 与 contains", () => {
  it("解析 [[path]] / [[path#heading]] / [[path|alias]] 三种写法", () => {
    expect(parseExpression("[[A]]")).toEqual({
      kind: "wiki",
      raw: "[[A]]",
      target: "A",
    });
    expect(parseExpression("[[A#标题]]")).toEqual({
      kind: "wiki",
      raw: "[[A#标题]]",
      target: "A",
      subpath: "标题",
    });
    expect(parseExpression("[[A|别名]]")).toEqual({
      kind: "wiki",
      raw: "[[A|别名]]",
      target: "A",
    });
  });

  it("contains 的两个实参按表达式解析", () => {
    expect(
      parseExpression(
        "contains(file.outlinks, [[02 System/02 System_AI/Global_MOCs/_Area_MOC]])"
      )
    ).toEqual({
      kind: "contains",
      list: fieldExpr("file.outlinks"),
      value: {
        kind: "wiki",
        raw: "[[02 System/02 System_AI/Global_MOCs/_Area_MOC]]",
        target: "02 System/02 System_AI/Global_MOCs/_Area_MOC",
      },
    });
  });

  it("比较右值支持 wikilink", () => {
    expect(parseQuery("TABLE file.link\nWHERE file.path = [[A]]").where).toEqual(
      termOf(
        fieldExpr("file.path"),
        "=",
        { kind: "wiki", raw: "[[A]]", target: "A" }
      )
    );
  });
});

describe("parseExpression：startswith", () => {
  it('解析 startswith(value, "prefix")', () => {
    expect(parseExpression('startswith(file.name, "00.")')).toEqual({
      kind: "startswith",
      value: fieldExpr("file.name"),
      prefix: literalExpr("00."),
    });
  });

  it("WHERE 中与 ! / AND 组合（! 走 falsy 分支）", () => {
    const src = `TABLE file.link
WHERE !contains(file.outlinks, [[MOC]])
AND !startswith(file.name, "00.")`;
    expect(parseQuery(src).where).toEqual({
      kind: "group",
      op: "and",
      terms: [
        termOf(
          {
            kind: "contains",
            list: fieldExpr("file.outlinks"),
            value: { kind: "wiki", raw: "[[MOC]]", target: "MOC" },
          },
          "falsy"
        ),
        termOf(
          {
            kind: "startswith",
            value: fieldExpr("file.name"),
            prefix: literalExpr("00."),
          },
          "falsy"
        ),
      ],
    });
  });
});

describe("parseExpression：endswith", () => {
  it('解析 endswith(value, "suffix")', () => {
    expect(parseExpression('endswith(file.name, ".md")')).toEqual({
      kind: "endswith",
      value: fieldExpr("file.name"),
      suffix: literalExpr(".md"),
    });
  });
});

describe("parseWhere", () => {
  it("AND 优先级高于 OR", () => {
    expect(parseWhere("a = 1 AND b = 2 OR c = 3")).toEqual({
      kind: "group",
      op: "or",
      terms: [
        {
          kind: "group",
          op: "and",
          terms: [termOf(fieldExpr("a"), "=", literalExpr("1")), termOf(fieldExpr("b"), "=", literalExpr("2"))],
        },
        termOf(fieldExpr("c"), "=", literalExpr("3")),
      ],
    });
  });

  it("支持纯 AND 组", () => {
    expect(parseWhere('file.name != "a" AND file.name != "b"')).toEqual({
      kind: "group",
      op: "and",
      terms: [
        termOf(fieldExpr("file.name"), "!=", literalExpr("a")),
        termOf(fieldExpr("file.name"), "!=", literalExpr("b")),
      ],
    });
  });
});

describe("parseQuery", () => {
  it("解析基本 TABLE 与列定义", () => {
    const q = asTable(parseQuery("TABLE file.link, description"));
    expect(q.withoutId).toBe(false);
    expect(q.columns).toEqual([col("file.link"), col("description")]);
    expect(q.from).toBeNull();
    expect(q.where).toBeNull();
    expect(q.sort).toBeNull();
  });

  it("解析 WITHOUT ID", () => {
    const q = asTable(parseQuery("TABLE WITHOUT ID description"));
    expect(q.withoutId).toBe(true);
  });

  it("解析 AS 别名（含引号）", () => {
    const q = asTable(
      parseQuery('TABLE file.link AS "文章", description AS "描述"')
    );
    expect(q.columns).toEqual([
      col("file.link", "文章"),
      col("description", "描述"),
    ]);
  });

  it("解析 FROM 路径", () => {
    const q = parseQuery('TABLE name\nFROM "01 Note/02_Areas/RNA-seq"');
    expect(q.from).toEqual({
      kind: "folder",
      path: "01 Note/02_Areas/RNA-seq",
    });
  });

  it("解析 FROM #tag", () => {
    expect(parseQuery("TABLE name\nFROM #project/sub").from).toEqual({
      kind: "tag",
      tag: "project/sub",
    });
  });

  it("解析 WHERE != 条件", () => {
    const q = parseQuery('TABLE name\nWHERE file.name != "00.RNA-seq Index"');
    expect(q.where).toEqual(
      termOf(fieldExpr("file.name"), "!=", literalExpr("00.RNA-seq Index"))
    );
  });

  it("解析 WHERE = 条件", () => {
    const q = parseQuery('TABLE name\nWHERE file.name = "a"');
    expect(q.where).toEqual(
      termOf(fieldExpr("file.name"), "=", literalExpr("a"))
    );
  });

  it("解析 SORT ASC / DESC / 默认", () => {
    expect(parseQuery("TABLE name\nSORT name ASC").sort).toEqual({
      field: "name",
      desc: false,
    });
    expect(parseQuery("TABLE name\nSORT name DESC").sort).toEqual({
      field: "name",
      desc: true,
    });
    expect(parseQuery("TABLE name\nSORT name").sort).toEqual({
      field: "name",
      desc: false,
    });
  });

  it("无 WHERE/SORT 时为 null", () => {
    const q = parseQuery("TABLE name");
    expect(q.where).toBeNull();
    expect(q.sort).toBeNull();
    expect(q.limit).toBeNull();
  });

  it("解析 LIMIT 行数", () => {
    expect(parseQuery("TABLE name\nLIMIT 5").limit).toEqual({ count: 5 });
    expect(parseQuery("TABLE name\nLIMIT 0").limit).toEqual({ count: 0 });
  });

  it("LIMIT 非法值抛出 QueryParseError", () => {
    expect(() => parseQuery("TABLE name\nLIMIT abc")).toThrow(QueryParseError);
    expect(() => parseQuery("TABLE name\nLIMIT -1")).toThrow(QueryParseError);
    expect(() => parseQuery("TABLE name\nLIMIT")).toThrow(QueryParseError);
  });

  it("解析用户完整示例", () => {
    const src = `TABLE WITHOUT ID
  file.link AS "文章",
  description AS "描述"
FROM "01 Note/02_Areas/RNA-seq"
WHERE file.name != "00.RNA-seq Index"
SORT file.name ASC
LIMIT 10`;
    const q = asTable(parseQuery(src));
    expect(q.withoutId).toBe(true);
    expect(q.columns).toEqual([
      col("file.link", "文章"),
      col("description", "描述"),
    ]);
    expect(q.from).toEqual({
      kind: "folder",
      path: "01 Note/02_Areas/RNA-seq",
    });
    expect(q.where).toEqual(
      termOf(fieldExpr("file.name"), "!=", literalExpr("00.RNA-seq Index"))
    );
    expect(q.sort).toEqual({ field: "file.name", desc: false });
    expect(q.limit).toEqual({ count: 10 });
  });

  it("目标查询 1：dateformat 列 + 数值 SORT + LIMIT", () => {
    const src = `TABLE dateformat(file.mtime, "yyyy-MM-dd HH:mm") AS "修改时间", file.folder AS "位置"
FROM "01 Note/02_Areas"
SORT file.mtime DESC
LIMIT 10`;
    const q = asTable(parseQuery(src));
    expect(q.columns).toEqual([
      {
        field: 'dateformat(file.mtime, "yyyy-MM-dd HH:mm")',
        alias: "修改时间",
        expr: {
          kind: "dateformat",
          source: fieldExpr("file.mtime"),
          format: "yyyy-MM-dd HH:mm",
        },
      },
      col("file.folder", "位置"),
    ]);
    expect(q.sort).toEqual({ field: "file.mtime", desc: true });
    expect(q.limit).toEqual({ count: 10 });
  });

  it("目标查询 2：多行 WHERE 续行并入上一个子句", () => {
    const src = `TABLE file.folder AS 位置, file.mtime AS 修改时间
FROM "01 Note/00_Personal"
WHERE file.name != "00.Personal Index"
  AND file.name != "存量笔记重分类清单"
SORT file.folder`;
    const q = asTable(parseQuery(src));
    expect(q.columns).toEqual([
      col("file.folder", "位置"),
      col("file.mtime", "修改时间"),
    ]);
    expect(q.where).toEqual({
      kind: "group",
      op: "and",
      terms: [
        termOf(fieldExpr("file.name"), "!=", literalExpr("00.Personal Index")),
        termOf(fieldExpr("file.name"), "!=", literalExpr("存量笔记重分类清单")),
      ],
    });
    expect(q.sort).toEqual({ field: "file.folder", desc: false });
  });

  it("目标查询 3：!contains(file.outlinks, [[wikilink]]) + 续行 AND", () => {
    const src = `TABLE WITHOUT ID file.link AS "文章", file.folder AS "位置"
FROM "01 Note/02_Areas"
WHERE !contains(file.outlinks, [[02 System/02 System_AI/Global_MOCs/_Area_MOC]])
AND file.name != "00."
SORT file.mtime DESC`;
    const q = asTable(parseQuery(src));
    expect(q.withoutId).toBe(true);
    expect(q.columns).toEqual([
      col("file.link", "文章"),
      col("file.folder", "位置"),
    ]);
    expect(q.from).toEqual({ kind: "folder", path: "01 Note/02_Areas" });
    expect(q.where).toEqual({
      kind: "group",
      op: "and",
      terms: [
        {
          kind: "term",
          left: {
            kind: "contains",
            list: fieldExpr("file.outlinks"),
            value: {
              kind: "wiki",
              raw: "[[02 System/02 System_AI/Global_MOCs/_Area_MOC]]",
              target: "02 System/02 System_AI/Global_MOCs/_Area_MOC",
            },
          },
          op: "falsy",
        },
        termOf(fieldExpr("file.name"), "!=", literalExpr("00.")),
      ],
    });
    expect(q.sort).toEqual({ field: "file.mtime", desc: true });
    expect(q.limit).toBeNull();
  });

  it("解析 LIST（无字段 = 仅文件链接）", () => {
    const q = asList(parseQuery("LIST FROM #project"));
    expect(q.format).toBeNull();
    expect(q.withoutId).toBe(false);
    expect(q.from).toEqual({ kind: "tag", tag: "project" });
    expect(q.where).toBeNull();
    expect(q.sort).toBeNull();
    expect(q.limit).toBeNull();
  });

  it("解析 LIST 字段与 WITHOUT ID", () => {
    const q = asList(parseQuery("LIST file.name\nFROM #project"));
    expect(q.format).toBe("file.name");
    expect(q.withoutId).toBe(false);

    const q2 = asList(parseQuery("LIST WITHOUT ID description"));
    expect(q2.format).toBe("description");
    expect(q2.withoutId).toBe(true);
  });

  it("LIST 字段含空格/AS 抛出 QueryParseError", () => {
    expect(() => parseQuery('LIST file.link AS "标题"')).toThrow(
      QueryParseError
    );
    expect(() => parseQuery("LIST a b")).toThrow(QueryParseError);
  });

  it("WHERE 布尔判断（truthy / !falsy）", () => {
    expect(parseQuery("TABLE name\nWHERE done").where).toEqual(
      termOf(fieldExpr("done"), "truthy")
    );
    expect(parseQuery("TASK FROM #x\nWHERE !completed").where).toEqual(
      termOf(fieldExpr("completed"), "falsy")
    );
  });

  it("解析 TASK（无载荷）", () => {
    const q = parseQuery("TASK FROM #project");
    expect(q.type).toBe("task");
    expect(q.from).toEqual({ kind: "tag", tag: "project" });
    expect(q.where).toBeNull();
  });

  it("TASK 带 WITHOUT ID / 字段抛出 QueryParseError", () => {
    expect(() => parseQuery("TASK WITHOUT ID")).toThrow(QueryParseError);
    expect(() => parseQuery("TASK text")).toThrow(QueryParseError);
  });

  it("不支持的函数名抛出 QueryParseError", () => {
    expect(() => parseQuery('TABLE lower(file.name) AS "x"')).toThrow(
      QueryParseError
    );
  });

  it("非法语法抛出 QueryParseError", () => {
    expect(() => parseQuery("")).toThrow(QueryParseError);
    expect(() => parseQuery("TODO name")).toThrow(QueryParseError);
    expect(() => parseQuery("TABLE")).toThrow(QueryParseError);
    expect(() => parseQuery("TABLE name\nWHERE a b")).toThrow(QueryParseError);
    expect(() => parseQuery("TABLE name\nFROM")).toThrow(QueryParseError);
    expect(() => parseQuery("TABLE name\nFROM #")).toThrow(QueryParseError);
  });
});
