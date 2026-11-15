// Warnings returned by the science endpoints (spectrum, astrometry). Known codes are localized; any other code
// falls back to the text sent by the API so that nothing is hidden.
import { useTranslation } from 'react-i18next';
import type { ApiWarning } from '../../lib/types';

/** Warnings that change how a result must be read are shown prominently. */
export const PROMINENT = new Set([
  'SATURATION',
  'BLENDED_SOURCE',
  'EPSILON_INDI_UNRESOLVED',
  'NO_REDUNDANCY',
]);

export function hasCode(list: ApiWarning[] | undefined, re: RegExp): boolean {
  return !!list?.some((w) => re.test(w.code));
}

export function WarningList({
  warnings,
  skip,
  testId,
}: {
  warnings: ApiWarning[] | undefined;
  skip?: ReadonlySet<string>;
  testId?: string;
}) {
  const { t, i18n } = useTranslation();
  const list = (warnings ?? []).filter((w) => !skip?.has(w.code));
  if (list.length === 0) return null;
  return (
    <section aria-label={t('sciWarn.title')} className="flex flex-col gap-2" data-testid={testId}>
      <ul className="flex flex-col gap-2">
        {list.map((w) => {
          const key = `sciWarn.codes.${w.code}`;
          const known = i18n.exists(key);
          const prominent = PROMINENT.has(w.code);
          return (
            <li
              key={w.code}
              className={`rounded-lg border p-2.5 text-label-13 ${prominent ? 'border-warning' : 'border-border'}`}
              data-code={w.code}
            >
              {known ? (
                <>
                  <span className="font-semibold">{t(`${key}.t`)}</span>{' '}
                  <span className="text-text-2">{t(`${key}.b`)}</span>
                </>
              ) : (
                <>
                  <span className="font-semibold">{t('sciWarn.other')}</span>{' '}
                  <span className="text-text-2">{w.detail ?? ''}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
