/**
 * 在 Windows 文件资源管理器中打开（《需求与设计文档》8.4 的延伸）
 *
 * 归档完之后经常要「去资源管理器里看一眼」—— 以前得自己从 NAS 一级级点进去。
 *
 * 两种形态：
 *  - `select = true`  → `explorer /select,"<文件>"`：打开所在文件夹**并选中**该文件
 *  - `select = false` → `explorer "<文件夹>"`：直接打开该文件夹
 *
 * ⚠ 四个坑（前两个都会「静默打开文档」，极难排查，都是实测踩出来的）：
 *
 *  1. **绝不能传 `windowsHide: true`**：libuv 会因此设
 *     `UV_PROCESS_WINDOWS_HIDE_GUI` → `STARTUPINFO.wShowWindow = SW_HIDE`，
 *     资源管理器窗口**被创建但隐藏**：命令成功、`'spawn'` 事件照常触发，屏幕上却什么都不出现。
 *     （`cmd /c start` 不受影响，因为 SW_HIDE 只作用于 cmd 自己 —— 这就是「▶ 播放」一直正常的原因。）
 *
 *  2. **`/select,` 的引号只能包住路径**：`/select,"<路径>"` ✅，`"/select,<路径>"` ❌。
 *     而 Node 的 spawn **默认会给含空格的参数整串加引号**，正好是错的那种 ——
 *     于是资源管理器解析失败，**静默把「文档」打开**，看起来像成功。
 *     所以这里用 `windowsVerbatimArguments: true` 自己拼命令行，不让 Node 插手加引号。
 *
 *  3. **explorer.exe 成功时也会返回退出码 1**（历史行为），不能靠退出码判断成败 ——
 *     这里只等 `'spawn'` 事件（能起来就算成功）。
 *
 *  4. 传进来的是文件夹却要求 select 时，退回「直接打开文件夹」—— 否则 explorer 会弹文档。
 */
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { exists, toLongPath } from '../fsx/fsx';

/**
 * 供自检使用：拼 `explorer.exe` 的**原始**参数。
 *
 * 引号**只能包住路径**：`/select,"<路径>"` ✅，`"/select,<路径>"` ❌（后者会静默打开「文档」）。
 * 配合 `windowsVerbatimArguments: true` 使用，命令行由我们原样拼出、不让 Node 插手加引号。
 */
export function explorerArgs(p: string, select = false): string[] {
  const quoted = `"${p}"`;
  return [select ? `/select,${quoted}` : quoted];
}

export async function revealInExplorer(targetPath: string, select = false): Promise<string> {
  const p = String(targetPath ?? '').trim();
  if (!p) throw new Error('路径不能为空');
  // 下面要手工拼命令行（windowsVerbatimArguments 不做转义），双引号必须提前挡掉。
  // Windows 文件名本身不允许 `"`，所以正常路径不会命中这里。
  if (p.includes('"')) throw new Error(`路径含非法字符 "：「${p}」`);
  if (!(await exists(p))) throw new Error(`路径不存在或不可访问：「${p}」`);
  if (process.platform !== 'win32') throw new Error('当前实现仅支持 Windows');

  let isDir = false;
  try {
    isDir = (await fsp.stat(toLongPath(p))).isDirectory();
  } catch {
    isDir = false;
  }

  // 只给路径加引号（见文件头第 2 条），整串交给系统原样解析
  const args = explorerArgs(p, select && !isDir);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('explorer.exe', args, {
      windowsHide: false,
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });

  return p;
}
