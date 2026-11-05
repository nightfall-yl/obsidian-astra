import { describe, expect, it } from "vitest";
import {
  compareValues,
  evaluateExpression,
  evaluateWhere,
  formatCellValue,
  formatDate,
  isEmptyValue,
  resolveFieldValue,
  type FieldContext,
  type FileMeta
} from "./evaluate";
import type { Expr, WhereGroup, WhereSpec } from "./parser";
import { buildOutlinks } from "./outlinks";

const file: FileMeta = {
  basename: "note",
  path: "01 Note/02_Areas/note.md",
  folder: "01 Note/02_Areas",
  mtime: new Date(2026, 10, 5, 9, 7, 3).getTime(),
  ctime: new Date(2026, 10, 4, 8, 6, 2).getTime(),
  size: 2048,
  outlinks: []
};

const ctx: FieldContext = { file, frontmatter: { status: "done", done: true } };

const fieldExpr = (field: string): Expr => ({ kind: "field", field });
const literalExpr = (value: string): Expr => ({ kind: "literal", value });

describe("formatDate", () => {
  it("支持 yyyy / MM / dd / HH / mm / ss 等占位符", () => {
    const ts = file.mtime;
    expect(formatDate(ts, "yyyy-MM-dd HH:mm")).toBe("2026-11-05 09:07");
    expect(formatDate(ts, "yyyy/MM/dd")).toBe("2026/11/05");
    expect(formatDate(ts, "HH:mm:ss")).toBe("09:07:03");
    expect(formatDate(ts, "sss")).toBe("000");
  });

  it("非时间值返回空串，未知字符原样保留", () => {
    expect(formatDate(Number.NaN, "yyyy")).toBe("");
    expect(formatDate(file.mtime, "yyyy年MM月")).toBe("2026年11月");
  });
});

describe("resolveFieldValue", () => {
  it("支持 file.mtime / ctime / size 数值字段", () => {
    expect(resolveFieldValue(ctx, "file.mtime")).toBe(file.mtime);
    expect(resolveFieldValue(ctx, "file.ctime")).toBe(file.ctime);
    expect(resolveFieldValue(ctx, "file.size")).toBe(2048);
    expect(resolveFieldValue(ctx, "file.folder")).toBe("01 Note/02_Areas");
    expect(resolveFieldValue(ctx, "file.outlinks")).toEqual([]);
  });

  it("回退到 frontmatter", () => {
    expect(resolveFieldValue(ctx, "status")).toBe("done");
    expect(resolveFieldValue(ctx, "missing")).toBeNull();
  });
});

describe("evaluateExpression", () => {
  it("dateformat 把毫秒时间格式化为字符串", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "dateformat",
        source: fieldExpr("file.mtime"),
        format: "yyyy-MM-dd HH:mm"
      })
    ).toBe("2026-11-05 09:07");
  });

  it("dateformat 遇空值返回 null", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "dateformat",
        source: fieldExpr("missing"),
        format: "yyyy"
      })
    ).toBeNull();
  });
});

describe("contains", () => {
  const mocTarget = "02 System/02 System_AI/Global_MOCs/_Area_MOC";
  const mocPath = `${mocTarget}.md`;
  const linkCtx: FieldContext = {
    file: { ...file, outlinks: [mocPath, "01 Note/02_Areas/other.md"] },
    // 模拟 metadataCache 解析：目标 → 带 .md 的路径，其余不可解析
    resolveLink: (target) => (target === mocTarget ? mocPath : null)
  };
  const containsExpr = (target: string): Expr => ({
    kind: "contains",
    list: fieldExpr("file.outlinks"),
    value: { kind: "wiki", raw: `[[${target}]]`, target }
  });

  it("命中：wikilink 解析后与 outlinks 路径全等", () => {
    expect(evaluateExpression(linkCtx, containsExpr(mocTarget))).toBe(true);
  });

  it("不命中：目标不在列表", () => {
    expect(evaluateExpression(linkCtx, containsExpr("Other"))).toBe(false);
  });

  it("空数组不命中", () => {
    expect(
      evaluateExpression(
        { ...linkCtx, file: { ...file, outlinks: [] } },
        containsExpr(mocTarget)
      )
    ).toBe(false);
  });

  it("左侧不是数组时返回 false", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "contains",
        list: fieldExpr("status"),
        value: literalExpr("done")
      })
    ).toBe(false);
  });

  it("!contains 由 falsy 分支取反", () => {
    expect(
      evaluateWhere(linkCtx, {
        kind: "term",
        left: containsExpr(mocTarget),
        op: "falsy"
      })
    ).toBe(false);
    expect(
      evaluateWhere(linkCtx, {
        kind: "term",
        left: containsExpr("Other"),
        op: "falsy"
      })
    ).toBe(true);
  });
});

describe("startswith", () => {
  const startswithExpr = (value: string, prefix: string): Expr => ({
    kind: "startswith",
    value: literalExpr(value),
    prefix: literalExpr(prefix)
  });

  it("命中：严格前缀", () => {
    expect(evaluateExpression(ctx, startswithExpr("00.Index", "00."))).toBe(true);
  });

  it("不命中：前缀不在开头", () => {
    expect(evaluateExpression(ctx, startswithExpr("Index", "00."))).toBe(false);
  });

  it("大小写敏感", () => {
    expect(evaluateExpression(ctx, startswithExpr("Note", "note"))).toBe(false);
    expect(evaluateExpression(ctx, startswithExpr("Note", "Note"))).toBe(true);
  });

  it("左侧 null 返回 false", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "startswith",
        value: fieldExpr("missing"),
        prefix: literalExpr("x")
      })
    ).toBe(false);
  });

  it("左侧为数组返回 false", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "startswith",
        value: fieldExpr("file.outlinks"),
        prefix: literalExpr("01")
      })
    ).toBe(false);
  });

  it("!startswith 由 falsy 分支取反", () => {
    expect(
      evaluateWhere(ctx, {
        kind: "term",
        left: startswithExpr("00.Index", "00."),
        op: "falsy"
      })
    ).toBe(false);
    expect(
      evaluateWhere(ctx, {
        kind: "term",
        left: startswithExpr("Index", "00."),
        op: "falsy"
      })
    ).toBe(true);
  });
});

describe("endswith", () => {
  const endswithExpr = (value: string, suffix: string): Expr => ({
    kind: "endswith",
    value: literalExpr(value),
    suffix: literalExpr(suffix)
  });

  it("命中：严格后缀", () => {
    expect(evaluateExpression(ctx, endswithExpr("Index.md", ".md"))).toBe(true);
  });

  it("不命中：后缀不在结尾", () => {
    expect(evaluateExpression(ctx, endswithExpr("Index.md", ".txt"))).toBe(false);
  });

  it("大小写敏感", () => {
    expect(evaluateExpression(ctx, endswithExpr("Note.MD", ".md"))).toBe(false);
    expect(evaluateExpression(ctx, endswithExpr("Note.md", ".md"))).toBe(true);
  });

  it("左侧 null 返回 false", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "endswith",
        value: fieldExpr("missing"),
        suffix: literalExpr("x")
      })
    ).toBe(false);
  });

  it("左侧为数组返回 false", () => {
    expect(
      evaluateExpression(ctx, {
        kind: "endswith",
        value: fieldExpr("file.outlinks"),
        suffix: literalExpr("md")
      })
    ).toBe(false);
  });

  it("!endswith 由 falsy 分支取反", () => {
    expect(
      evaluateWhere(ctx, {
        kind: "term",
        left: endswithExpr("Index.md", ".md"),
        op: "falsy"
      })
    ).toBe(false);
    expect(
      evaluateWhere(ctx, {
        kind: "term",
        left: endswithExpr("Index.md", ".txt"),
        op: "falsy"
      })
    ).toBe(true);
  });
});

describe("buildOutlinks", () => {
  const sourcePath = "01 Note/02_Areas/self.md";
  const resolve = (target: string): string | null => {
    switch (target) {
      case "A":
        return "01 Note/02_Areas/A.md";
      case "B":
        return "01 Note/02_Areas/B.md";
      case sourcePath:
        return sourcePath;
      default:
        return null;
    }
  };

  it("合并 links 与 embeds，按解析后路径去重", () => {
    expect(
      buildOutlinks(
        [{ link: "A" }, { link: "A#标题" }, { link: "B" }],
        [{ link: "A" }, { link: "B|别名" }],
        sourcePath,
        resolve
      )
    ).toEqual(["01 Note/02_Areas/A.md", "01 Note/02_Areas/B.md"]);
  });

  it("无法解析的链接被丢弃", () => {
    expect(
      buildOutlinks([{ link: "missing" }, { link: "A" }], [], sourcePath, resolve)
    ).toEqual(["01 Note/02_Areas/A.md"]);
  });

  it("纯 #heading 自引用解析为源文件自身", () => {
    expect(
      buildOutlinks([{ link: "#标题" }], [], sourcePath, resolve)
    ).toEqual([sourcePath]);
  });

  it("links / embeds 缺省时返回空数组", () => {
    expect(buildOutlinks(undefined, undefined, sourcePath, resolve)).toEqual([]);
  });
});

describe("evaluateWhere", () => {
  const andSpec: WhereGroup = {
    kind: "group",
    op: "and",
    terms: [
      { kind: "term", left: fieldExpr("status"), op: "=", right: literalExpr("done") },
      { kind: "term", left: fieldExpr("done"), op: "truthy" }
    ]
  };
  const orSpec: WhereSpec = {
    kind: "group",
    op: "or",
    terms: [
      { kind: "term", left: fieldExpr("missing"), op: "truthy" },
      { kind: "term", left: fieldExpr("done"), op: "truthy" }
    ]
  };

  it("AND 需要全部成立，OR 只需一条成立", () => {
    expect(evaluateWhere(ctx, andSpec)).toBe(true);
    expect(evaluateWhere(ctx, orSpec)).toBe(true);
    expect(
      evaluateWhere(ctx, {
        ...andSpec,
        terms: [
          ...andSpec.terms,
          { kind: "term", left: fieldExpr("missing"), op: "truthy" }
        ]
      })
    ).toBe(false);
  });

  it("!= 与字符串比较", () => {
    expect(
      evaluateWhere(ctx, {
        kind: "term",
        left: fieldExpr("file.folder"),
        op: "!=",
        right: literalExpr("other")
      })
    ).toBe(true);
  });
});

describe("compareValues / isEmptyValue", () => {
  it("数值按数值比较，避免字符串字典序", () => {
    expect(compareValues(9, 10)).toBeLessThan(0);
    expect(compareValues(10, 9)).toBeGreaterThan(0);
    expect(compareValues(file.mtime, file.ctime)).toBeGreaterThan(0);
  });

  it("字符串仍按 localeCompare", () => {
    expect(compareValues("a", "b")).toBeLessThan(0);
    expect(compareValues("b", "a")).toBeGreaterThan(0);
  });

  it("空值判定覆盖 null / undefined / 空串 / 空数组", () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue("x")).toBe(false);
  });
});

describe("formatCellValue", () => {
  it("file.mtime / file.ctime 默认渲染为可读时间", () => {
    expect(formatCellValue("file.mtime", file.mtime)).toBe("2026-11-05 09:07");
    expect(formatCellValue("file.ctime", file.ctime)).toBe("2026-11-04 08:06");
  });

  it("其他字段与数组走普通字符串化", () => {
    expect(formatCellValue("file.name", "note")).toBe("note");
    expect(formatCellValue("tags", ["a", "b"])).toBe("a, b");
    expect(formatCellValue("missing", null)).toBe("");
  });
});
