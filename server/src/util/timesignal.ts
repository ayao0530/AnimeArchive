/**
 * 文件修改时间线索（提高置信度的第二个参考参数）
 *
 * 原理：文件的修改时间 ≈ 你把它下载 / 拷贝进来的时间，所以
 *   ① 番剧的首播时间 **必然早于或等于** 文件时间（不可能在开播前就下载到）
 *   ② 若候选首播时间与文件时间同季 → 极可能是**当季追番** → 强烈加分
 *   ③ 隔 1~2 年 → 补番，轻微加分；隔很久 → 老番补看，不加分
 *
 * 这个信号对「续作 vs 第一季」的区分尤其有效：
 *   `Hataraku Saibou!!`（文件时间 2021-02）→ 第 2 季（2021-01）加分，第一季（2018-07）不加分。
 */
import type { TimeRelation } from '../types';

export interface TimeHint {
  /** 同组（同番剧名）文件里最早的修改时间（毫秒） */
  earliestMs: number;
  /** 最晚的修改时间 */
  latestMs: number;
}

export interface TimeAdjust {
  /** 叠加到置信度上的分数（可正可负） */
  delta: number;
  relation: TimeRelation;
}

export const NO_TIME_ADJUST: TimeAdjust = { delta: 0, relation: 'unknown' };

/**
 * 候选项首播时间 vs 文件修改时间
 */
export function timeAdjust(
  candYear: number | null | undefined,
  candMonth: number | null | undefined,
  hint?: TimeHint | null
): TimeAdjust {
  if (!hint || !candYear || !Number.isFinite(hint.earliestMs)) return NO_TIME_ADJUST;

  const d = new Date(hint.earliestMs);
  if (Number.isNaN(d.getTime())) return NO_TIME_ADJUST;
  const fileY = d.getFullYear();
  const fileM = d.getMonth() + 1;

  // 候选项首播与文件时间的月份差（负 = 过去，正 = 未来）
  const diff = (candYear - fileY) * 12 + ((candMonth || 1) - fileM);

  if (diff > 1) return { delta: -0.30, relation: 'future' };      // 文件比首播还早 → 不可能，重罚
  if (diff > 0) return { delta: -0.05, relation: 'same' };        // 首播月精度问题，轻微降权
  const gap = -diff;                                              // 距首播已过去多少个月
  if (gap <= 4) return { delta: 0.14, relation: 'same' };         // 当季追番
  if (gap <= 15) return { delta: 0.10, relation: 'near' };        // 同年 / 隔一季
  if (gap <= 30) return { delta: 0.05, relation: 'stock' };       // 一年内补番
  if (gap <= 120) return { delta: 0, relation: 'old' };           // 老番补看：不奖不罚
  return { delta: -0.04, relation: 'old' };
}

/** 时间线索的可读说明（界面展示用） */
export function describeTimeHint(hint: TimeHint | null | undefined, candYear?: number | null, candMonth?: number | null): string {
  if (!hint) return '';
  const d = new Date(hint.earliestMs);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  if (!candYear) return `文件时间 ${stamp}`;
  const adj = timeAdjust(candYear, candMonth, hint);
  const label: Record<TimeRelation, string> = {
    same: '与文件时间同季',
    near: '与文件时间同年',
    stock: '晚于首播 1~2 年',
    old: '晚于首播 2 年以上',
    future: '⚠ 首播晚于文件时间',
    unknown: ''
  };
  return `文件时间 ${stamp} · 首播 ${candYear}-${p(candMonth || 1)} ${label[adj.relation]}`.trim();
}
