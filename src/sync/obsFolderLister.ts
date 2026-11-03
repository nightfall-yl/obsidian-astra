/**
 * (src/obsFolderLister.ts). The @fyears/tsqueue dependency is replaced by a
 * plain array used as a LIFO queue (order does not matter here).
 */

import type { Vault} from "obsidian";
import { type ListedFiles } from "obsidian";

import { statFix } from "./misc";

export interface ObsConfigDirFileType {
  key: string;
  ctime: number;
  mtime: number;
  size: number;
  type: "folder" | "file";
}

const isFolderToSkip = (x: string) => {
  const specialFolders = [
    ".git",
    ".github",
    ".gitlab",
    ".svn",
    "node_modules",
    ".DS_Store",
  ];
  for (const iterator of specialFolders) {
    if (
      x === iterator ||
      x === `${iterator}/` ||
      x.endsWith(`/${iterator}`) ||
      x.endsWith(`/${iterator}/`)
    ) {
      return true;
    }
  }
  return false;
};

const isPluginDirItself = (x: string, pluginId: string) => {
  return (
    x === pluginId ||
    x === pluginId + "/" ||
    x.endsWith("/" + pluginId) ||
    x.endsWith("/" + pluginId + "/")
  );
};

const isLikelyPluginSubFiles = (x: string) => {
  const reqFiles = [
    "data.json",
    "main.js",
    "manifest.json",
    ".gitignore",
    "styles.css",
  ];
  for (const iterator of reqFiles) {
    if (x === iterator || x.endsWith(`/${iterator}`)) {
      return true;
    }
  }
  return false;
};

export const isInsideObsFolder = (x: string, configDir: string) => {
  if (!configDir.startsWith(".")) {
    throw Error(`configDir should starts with . but we get ${configDir}`);
  }
  return x === configDir || x.startsWith(`${configDir}/`);
};

export const isInsideTrashFolder = (path: string) => {
  return path.startsWith(".trash");
};

export const listFilesInObsFolder = async (
  vault: Vault,
  pluginId: string,
  syncTrash: boolean
) => {
  const searchFolders = [vault.configDir];
  if (syncTrash && (await vault.adapter.stat(".trash")) != null) {
    searchFolders.push(".trash");
  }
  const q: string[] = [...searchFolders];
  const CHUNK_SIZE = 10;
  const chunk = <T>(arr: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, i * size + size)
    );
  const contents: ObsConfigDirFileType[] = [];
  while (q.length > 0) {
    const itemsToFetch: string[] = [];
    while (q.length > 0) {
      const item = q.pop();
      if (item !== undefined) {
        itemsToFetch.push(item);
      }
    }

    const itemsToFetchChunks = chunk(itemsToFetch, CHUNK_SIZE);
    for (const singleChunk of itemsToFetchChunks) {
      const r = singleChunk.map(async (fsEntry) => {
        const statRes = await statFix(vault, fsEntry);

        const isFolder = statRes?.type === "folder";
        let children: ListedFiles | undefined = undefined;
        if (isFolder) {
          children = await vault.adapter.list(fsEntry);
        }

        return {
          itself: {
            key: isFolder ? `${fsEntry}/` : fsEntry,
            ctime: statRes?.ctime ?? 0,
            mtime: statRes?.mtime ?? 0,
            size: statRes?.size ?? 0,
            type: statRes?.type ?? "folder",
          },
          children: children,
        };
      });
      const r2 = (await Promise.all(r)).flat();

      for (const iter of r2) {
        contents.push(iter.itself);
        const isInsideSelfPlugin = isPluginDirItself(iter.itself.key, pluginId);
        if (iter.children !== undefined) {
          for (const iter2 of iter.children.folders) {
            if (isFolderToSkip(iter2)) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              // special treatment for self plugin folder
              continue;
            }
            q.push(iter2);
          }
          for (const iter2 of iter.children.files) {
            if (isFolderToSkip(iter2)) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              // special treatment for self plugin folder
              continue;
            }
            q.push(iter2);
          }
        }
      }
    }
  }
  return contents;
};
