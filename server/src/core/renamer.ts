/**
 * 手动重命名（《需求与设计文档》9.8）
 *
 * 只允许改「番剧文件夹名」这一层：`{年份}\{月份}\{番剧文件夹}`
 *  - ❌ 文件名不改
 *  - ❌ 年份 / 月份 层级不改
 */
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { Store } from './store';
import { exists, isValidFolderName, toLongPath } from '../fsx/fsx';

export interface RenameRequest {
  /** 相对于媒体库根目录的路径，如 `2022\10\孤独摇滚！` */
  relPath: string;
  /** 新的文件夹名（仅最后一段） */
  newName: string;
}

export interface RenameResult {
  fromPath: string;
  toPath: string;
  relPath: string;
}

export async function renameAnimeFolder(
  store: Store,
  libraryRoot: string,
  req: RenameRequest
): Promise<RenameResult> {
  const rel = String(req.relPath ?? '').replace(/^[\\/]+|[\\/]+$/g, '');
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 1) throw new Error('缺少要重命名的文件夹路径');

  const newName = String(req.newName ?? '').trim();
  const check = isValidFolderName(newName);
  if (!check.ok) throw new Error(check.reason ?? '文件夹名不合法');

  // 只允许改最后一段；年份/月份层级禁止修改
  if (segments.length >= 3) {
    if (!/^\d{4}$/.test(segments[0])) throw new Error('路径首段不是年份目录，拒绝重命名');
    if (!/^\d{1,2}$/.test(segments[1])) throw new Error('路径第二段不是月份目录，拒绝重命名');
  }

  const fromPath = path.join(libraryRoot, ...segments);
  const parentDir = path.join(libraryRoot, ...segments.slice(0, -1));
  const toPath = path.join(parentDir, newName);

  if (!(await exists(fromPath))) throw new Error(`要重命名的文件夹不存在：「${fromPath}」`);
  if (fromPath.toLowerCase() === toPath.toLowerCase()) {
    return { fromPath, toPath, relPath: [...segments.slice(0, -1), newName].join('\\') };
  }
  // 重名检测（Windows 大小写不敏感）
  const siblings = await fsp.readdir(toLongPath(parentDir), { withFileTypes: true }).catch(() => []);
  const clash = siblings.find(e => e.name.toLowerCase() === newName.toLowerCase());
  if (clash) throw new Error(`同级目录下已存在同名文件夹「${clash.name}」，已拒绝以避免覆盖`);

  await fsp.rename(toLongPath(fromPath), toLongPath(toPath));

  await store.appendRenameLog({
    renameId: `rn-${Date.now()}`,
    fromPath,
    toPath,
    result: 'success',
    error: null,
    timestamp: new Date().toISOString()
  });

  return { fromPath, toPath, relPath: [...segments.slice(0, -1), newName].join('\\') };
}
