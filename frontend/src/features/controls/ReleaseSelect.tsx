// Data release selector (F-17). Lists the SPHEREx collections the backend serves; the default
// release is the one the backend marks as default ("all": every release, newest version of each
// image), and choosing it removes the URL parameter.
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useReleases } from '../explorer/useView';

interface Props {
  value: string | undefined;
  onChange: (release: string | undefined) => void;
  inline?: boolean;
}

export function ReleaseSelect({ value, onChange, inline = false }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const data = useReleases().data;
  if (!data || data.releases.length === 0) return null;
  const current = value ?? data.default;
  const known = current === 'all' || data.releases.some((r) => r.collection === current);

  return (
    <div data-testid="release-select">
      <label
        htmlFor={id}
        className={
          inline
            ? 'mb-1.5 block text-caption-12 font-semibold text-muted'
            : 'mb-1.5 block text-caption-12 font-semibold uppercase tracking-wider text-muted'
        }
      >
        {t('release.label')}
      </label>
      <select
        id={id}
        value={current}
        onChange={(e) => onChange(e.target.value === data.default ? undefined : e.target.value)}
        className="min-h-[var(--hit-min)] min-w-[132px] max-w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-label-13 font-medium text-text hover:bg-border"
        data-testid="release-input"
      >
        {current === 'all' || data.default === 'all' ? (
          <option value="all">
            {data.default === 'all' ? t('release.default', { label: t('release.all') }) : t('release.all')}
          </option>
        ) : (
          !known && <option value={current}>{current}</option>
        )}
        {data.releases.map((r) => (
          <option key={r.collection} value={r.collection}>
            {r.collection === data.default ? t('release.default', { label: r.label }) : r.label}
          </option>
        ))}
      </select>
    </div>
  );
}
