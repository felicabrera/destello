// F-33 NEOSSat side panel (Canadian Space Agency): the nearest optical frame to the current SPHEREx exposure.
// A different telescope, band and time. The header positions are approximate, so no precise marker is drawn.
import { useTranslation } from 'react-i18next';
import { resolveAsset } from '../../lib/api';
import { localNumber } from '../../lib/format';
import type { Lang, NeossatDoc } from '../../lib/types';
import { CREDIT_NEOSSAT } from './cometModel';
import { utcTime } from './CometPlayer';

interface Props {
  lang: Lang;
  doc: NeossatDoc | null | undefined;
  loading: boolean;
  failed: boolean;
  obsId: string | undefined;
}

export function NeossatPanel({ lang, doc, loading, failed, obsId }: Props) {
  const { t } = useTranslation('comet');
  const item = doc?.items.find((i) => i.obs_id === obsId);
  const f = item?.neossat ?? null;
  const hours = doc?.window_hours ?? 24;
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
      aria-labelledby="neossat-h"
      data-testid="neossat-panel"
    >
      <h2 id="neossat-h" className="text-title-20 font-medium text-text">
        {t('neossat.title')}
      </h2>
      <p
        className="rounded-md border border-warning px-2 py-1 text-caption-12 text-text"
        data-testid="neossat-different"
      >
        {t('neossat.different')}
      </p>
      {loading ? (
        <p className="text-body-14 text-muted">{t('neossat.loading')}</p>
      ) : failed ? (
        <p className="text-body-14 text-text-2" role="alert">
          {t('neossat.failed')}
        </p>
      ) : !f ? (
        <div data-testid="neossat-empty" className="flex flex-col gap-1">
          <p className="text-body-14 font-semibold text-text">{t('neossat.none')}</p>
          <p className="text-body-14 text-text-2">{t('neossat.noneDetail', { hours })}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="neossat-frame">
          <img
            src={resolveAsset(f.cutout_url)}
            alt={t('neossat.imageAlt')}
            className="mx-auto aspect-square w-full max-w-[320px] rounded-md border border-border [image-rendering:pixelated]"
            data-testid="neossat-image"
          />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-14">
            <dt className="text-muted">{t('neossat.time')}</dt>
            <dd className="tnum text-text" data-testid="neossat-time">
              {utcTime(lang, f.t_mid_mjd)}
            </dd>
            <dt className="text-muted">{t('neossat.dt')}</dt>
            <dd className="tnum text-text" data-testid="neossat-dt">
              {t('neossat.dtValue', {
                value: localNumber(lang, Math.abs(f.dt_hours), 1),
                dir: f.dt_hours < 0 ? t('neossat.before') : t('neossat.after'),
              })}
            </dd>
            {f.fov_arcmin && (
              <>
                <dt className="text-muted">{t('neossat.fov')}</dt>
                <dd className="tnum text-text">
                  {t('neossat.fovValue', {
                    w: localNumber(lang, f.fov_arcmin[0], 1),
                    h: localNumber(lang, f.fov_arcmin[1], 1),
                  })}
                </dd>
              </>
            )}
            {f.exposure_s !== null && (
              <>
                <dt className="text-muted">{t('neossat.exposure')}</dt>
                <dd className="tnum text-text">
                  {t('neossat.exposureValue', { value: localNumber(lang, f.exposure_s, 0) })}
                </dd>
              </>
            )}
          </dl>
          <p className="text-caption-12 text-muted">{t('neossat.window', { hours })}</p>
          <p className="text-caption-12 text-text-2" data-testid="neossat-approx">
            {t('neossat.approx')}
          </p>
          <a
            href={f.access_url}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start text-label-13 text-cyan underline underline-offset-2"
          >
            {t('neossat.open')}
          </a>
        </div>
      )}
      <p className="text-caption-12 text-muted" data-testid="neossat-credit">
        {doc?.credit ?? CREDIT_NEOSSAT}
      </p>
    </section>
  );
}
