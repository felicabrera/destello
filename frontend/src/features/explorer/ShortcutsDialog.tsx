import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog';

const ROWS: { keys: string[]; label: string }[] = [
  { keys: ['Space'], label: 'shortcuts.playPause' },
  { keys: ['←', '→'], label: 'shortcuts.step' },
  { keys: ['Home', 'End'], label: 'shortcuts.firstLast' },
  { keys: ['+', '-'], label: 'shortcuts.speed' },
  { keys: ['1-6', '0'], label: 'shortcuts.detectors' },
  { keys: ['B', 'D', 'S', 'C'], label: 'shortcuts.modes' },
  { keys: ['T'], label: 'shortcuts.track' },
  { keys: ['G', 'W', 'F', 'P'], label: 'shortcuts.overlays' },
  { keys: ['M'], label: 'shortcuts.measure' },
  { keys: ['?'], label: 'shortcuts.help' },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
  onTour,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** F-24: restart the guided tour from this dialog. */
  onTour?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-dialog">
        <div className="flex items-start justify-between gap-4">
          <DialogTitle className="text-heading-24 font-medium">{t('shortcuts.title')}</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" aria-label={t('app.close')} className="-mr-2 -mt-1 px-2">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </Button>
          </DialogClose>
        </div>
        <DialogDescription className="mt-1 text-label-13 text-muted">{t('shortcuts.hint')}</DialogDescription>
        <dl className="mt-4">
          {ROWS.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0"
            >
              <dt className="text-label-13 text-text">{t(r.label)}</dt>
              <dd className="flex gap-1">
                {r.keys.map((k) => (
                  <kbd
                    key={k}
                    className="tnum min-w-7 rounded-sm border border-border-strong bg-surface-2 px-1.5 py-0.5 text-center text-caption-12 font-semibold text-text"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        {onTour && (
          <Button variant="secondary" className="mt-4" onClick={onTour} data-testid="tour-start">
            {t('tour.take')}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
