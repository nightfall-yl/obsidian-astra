// ================= Astra 查询：file.outlinks 构建（纯函数，无 Obsidian 依赖） =================
// 把 metadataCache 的 links / embeds 合并成「已解析目标路径」数组：
// - 含 embed（与 Dataview 一致）
// - 去掉 |alias，保留 #subpath（subpath 不参与路径解析）
// - 解析失败（resolver 返回 null）丢弃
// - 按解析后路径去重

/** metadataCache 中 links / embeds 条目的最小形状。 */
export interface LinkRef {
  link: string;
}

/**
 * 链接文本 → 解析目标文本：去掉 `|alias`，`#` 之后的部分不参与路径。
 * 纯 `#heading` 自引用（去掉后为空）解析为源文件自身。
 */
export function linkTarget(link: string, sourcePath: string): string {
  const withoutAlias = link.split("|")[0] ?? "";
  const target = withoutAlias.split("#")[0]!.trim();
  return target === "" ? sourcePath : target;
}

/**
 * 合并 links 与 embeds，按 resolver 解析为路径数组。
 * @param links  cache.links
 * @param embeds cache.embeds
 * @param sourcePath 源文件路径（纯 `#heading` 自引用时作为解析目标）
 * @param resolve 目标文本 → 已解析路径；返回 null 表示解析失败，该链接被丢弃
 */
export function buildOutlinks(
  links: readonly LinkRef[] | undefined,
  embeds: readonly LinkRef[] | undefined,
  sourcePath: string,
  resolve: (target: string) => string | null
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of [...(links ?? []), ...(embeds ?? [])]) {
    const target = linkTarget(ref.link, sourcePath);
    const resolved = resolve(target);
    if (resolved === null) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}
