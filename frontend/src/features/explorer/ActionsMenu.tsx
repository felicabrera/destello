// Overflow menu for the secondary explorer actions (results sheet, report). Same behaviour as the header "More"
// menu: aria-expanded and aria-controls on the opener, Escape and outside click close it, focus returns to the
// opener. The panel is fixed-positioned from the opener so a scrolling tools row cannot clip it.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

export interface ActionsMenuProps {
  onSheet?: () => void;
  report?: { reason: string | null; open: boolean; onToggle: () => void };
  /** Class of the opener button (the desktop and mobile rows size their buttons differently). */
  className?: string;
}

const itemCls =
  'flex min-h-[var(--hit-min)] w-full items-center rounded-md px-3 text-left text-body-14 font-medium text-text hover:bg-surface-2 aria-pressed:bg-surface-2 aria-disabled:text-disabled';

export function ActionsMenu({ onSheet, report, className }: ActionsMenuProps) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) openerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = openerRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = panelRef.current?.offsetWidth ?? 224;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    setPos({ top: r.bottom + 4, left });
  }, [open]);

  // Focus the first item once the panel is placed (a hidden panel cannot take focus).
  useEffect(() => {
    if (open && pos) panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close(true);
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
      if (items.length === 0 || !panelRef.current?.contains(document.activeElement)) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = (i + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next >= 0) {
        e.preventDefault();
        items[next]?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!panelRef.current?.contains(n) && !openerRef.current?.contains(n)) setOpen(false);
    };
    const onMove = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  if (!onSheet && !report) return null;

  // The item unmounts on close: focus goes back to the opener first so a dialog opened by the action restores it.
  const run = (fn: () => void) => () => {
    close(true);
    fn();
  };

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        className={cn(
          'grid min-h-[var(--hit-min)] min-w-[var(--hit-min)] flex-none place-items-center rounded-lg border border-border-strong bg-surface-2 text-text hover:bg-border',
          className,
        )}
        aria-label={t('actions.more')}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        data-testid="actions-more"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="group"
          aria-label={t('actions.more')}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          className="fixed z-40 flex w-56 flex-col rounded-lg border border-border bg-surface p-1 shadow-lg"
          data-testid="actions-menu"
        >
          {onSheet && (
            <button type="button" className={itemCls} onClick={run(onSheet)} data-testid="results-btn">
              {t('results.button')}
            </button>
          )}
          {report &&
            (report.reason ? (
              <button
                type="button"
                className={itemCls}
                aria-disabled
                aria-describedby={`${id}-reason`}
                title={report.reason}
                data-testid="report-btn"
              >
                {t('share.report')}
                <span id={`${id}-reason`} className="sr-only">
                  {report.reason}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className={itemCls}
                aria-pressed={report.open}
                onClick={run(report.onToggle)}
                data-testid="report-btn"
              >
                {t('share.report')}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
