/**
 * 调起 Windows 默认播放器（《需求与设计文档》8.4）
 *
 * 由本地服务执行 `start "" "<文件路径>"`，而非让浏览器直接打开 file://（不稳定）。
 */
import { spawn } from 'node:child_process';
import { exists } from '../fsx/fsx';

export async function playFile(fullPath: string): Promise<void> {
  const p = String(fullPath ?? '').trim();
  if (!p) throw new Error('文件路径不能为空');
  if (!(await exists(p))) throw new Error(`文件不存在或不可访问：「${p}」`);

  if (process.platform !== 'win32') {
    throw new Error('当前实现仅支持 Windows');
  }

  await new Promise<void>((resolve, reject) => {
    // 用 cmd 的 start 调起系统默认关联程序；空标题 "" 是 start 语法的必需占位
    // ⚠ windowsHide 必须留 false：libuv 的 windowsHide 会给子进程设 STARTUPINFO.wShowWindow = SW_HIDE，
    //   而 `start` 会把它转交给被启动的程序 → 播放器窗口「被创建但隐藏」。
    //   （这里已经 stdio:'ignore' + detached，本来就不会有控制台窗口闪一下）
    const child = spawn('cmd', ['/c', 'start', '', p], {
      windowsHide: false,
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
