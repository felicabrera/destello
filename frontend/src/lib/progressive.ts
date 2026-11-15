// Progressive builds (docs/06 sections 3.3 and 3.4): helpers that are pure so they can be tested.
import type { DetectorNum, DetectorSel, EpochInfo } from './types';
import { frameDetector } from './types';

/**
 * Merge the epochs of a partial manifest into the epochs already known.
 * An epoch already known with more frames (for example from `epoch_ready`) is kept.
 */
export function mergeEpochs(current: EpochInfo[], incoming: EpochInfo[]): EpochInfo[] {
  const byIndex = new Map<number, EpochInfo>();
  for (const e of current) byIndex.set(e.index, e);
  for (const e of incoming) {
    const cur = byIndex.get(e.index);
    if (!cur || cur.frames.length <= e.frames.length) byIndex.set(e.index, e);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Detector to show. While a build runs, the selected detector may not be published yet:
 * the first published detector is shown instead. A finished sequence always shows the selection.
 */
export function shownDetector(
  selected: DetectorSel,
  building: boolean,
  detectorsReady: number[],
  epochs: EpochInfo[],
): DetectorSel {
  if (!building || detectorsReady.length === 0) return selected;
  if (epochs.some((e) => e.frames.some((f) => frameDetector(f) === selected))) return selected;
  const first = detectorsReady[0];
  return first >= 1 && first <= 6 ? (first as DetectorNum) : selected;
}
