import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { PageShell, Section } from './PageShell';

export { ValidationPage } from './ValidationPage';

// Nominal SPHEREx detector bands in micrometers (instrument design values, docs/03 section 3).
const DETECTOR_BANDS: [number, number][] = [
  [0.75, 1.09],
  [1.09, 1.63],
  [1.63, 2.41],
  [2.41, 3.82],
  [3.82, 4.42],
  [4.42, 5.0],
];

export function SciencePage() {
  const { t } = useTranslation();
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;
  const toc = ids.map((k) => ({ id: `sci-${k}`, label: t(`sci.${k}.t`) }));
  const limits = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] as const;
  return (
    <PageShell
      kicker={t('sci.kicker')}
      title={t('sci.title')}
      lead={t('sci.lead')}
      toc={toc}
      tocLabel={t('sci.toc')}
      testId="page-science"
    >
      <Section id="sci-s1" n={1} title={t('sci.s1.t')}>
        <p>{t('sci.s1.p1')}</p>
        <p>{t('sci.s1.p2')}</p>
        <p>
          <Link
            to="/t/$target"
            params={{ target: 'barnard' }}
            className="text-label-13 text-cyan underline underline-offset-2"
          >
            {t('sci.play')}
          </Link>
        </p>
      </Section>
      <Section id="sci-s2" n={2} title={t('sci.s2.t')}>
        <p>{t('sci.s2.p1')}</p>
        <p>{t('sci.s2.p2')}</p>
      </Section>
      <Section id="sci-s3" n={3} title={t('sci.s3.t')}>
        <p>{t('sci.s3.p1')}</p>
        <p>{t('sci.s3.p2')}</p>
        <figure>
          <div
            className="overflow-x-auto rounded-lg border border-border"
            role="region"
            aria-label={t('sci.s3.caption')}
            // A scrollable region must be reachable by keyboard (axe scrollable-region-focusable).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
          >
            <table className="tnum w-full text-label-13" data-testid="detector-table">
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('sci.s3.thDet')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('sci.s3.thFrom')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('sci.s3.thTo')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {DETECTOR_BANDS.map(([a, b], i) => (
                  <tr key={i} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-text">
                      D{i + 1}
                    </th>
                    <td className="px-3 py-2 text-right">{a.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">{b.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <figcaption className="mt-2 text-caption-12 text-muted">{t('sci.s3.caption')}</figcaption>
        </figure>
      </Section>
      <Section id="sci-s4" n={4} title={t('sci.s4.t')}>
        <p>{t('sci.s4.p1')}</p>
        <p>{t('sci.s4.p2')}</p>
      </Section>
      <Section id="sci-s5" n={5} title={t('sci.s5.t')}>
        <p>{t('sci.s5.p1')}</p>
        <p>{t('sci.s5.p2')}</p>
      </Section>
      <Section id="sci-s6" n={6} title={t('sci.s6.t')}>
        <p>{t('sci.s6.p1')}</p>
        <dl className="mt-1 grid gap-3 sm:grid-cols-2" data-testid="science-limits">
          {limits.map((k) => (
            <div key={k} className="rounded-lg border border-border bg-surface p-3">
              <dt className="text-label-13 font-semibold text-text">{t(`sci.s6.${k}.t`)}</dt>
              <dd className="mt-1 text-label-13 text-text-2">{t(`sci.s6.${k}.d`)}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section id="sci-s7" n={7} title={t('sci.s7.t')}>
        <p>{t('sci.s7.p1')}</p>
        <p>
          <Link to="/about" hash="ack" className="text-label-13 text-cyan underline underline-offset-2">
            {t('sci.s7.link')}
          </Link>
        </p>
      </Section>
    </PageShell>
  );
}

export function AboutPage() {
  const { t } = useTranslation();
  const acks = ['spherex', 'gaia', 'wise', 'cds', 'jpl', 'software'] as const;
  const priv = ['accounts', 'ip', 'hosting', 'embeds', 'reports'] as const;
  // Deletion requests for reports go to the address set at build time (design handoff open item).
  const contactAddr = ((import.meta.env.VITE_CONTACT_EMAIL as string | undefined) || '').trim();
  const toc = [
    { id: 'about', label: t('pages.about') },
    { id: 'challenge', label: t('pages2.challengeTitle') },
    { id: 'ack', label: t('pages.ackTitle') },
    { id: 'priv', label: t('pages.privTitle') },
    { id: 'team', label: t('pages2.teamTitle') },
    { id: 'nonendorse', label: t('pages2.nonEndorseTitle') },
  ];
  return (
    <PageShell
      kicker={t('pages2.aboutKicker')}
      title={t('pages2.aboutTitle')}
      toc={toc}
      tocLabel={t('pages2.toc')}
      testId="page-about"
    >
      <Section id="about" title={t('pages.about')}>
        <p>{t('pages2.aboutP1')}</p>
        <p>{t('pages2.aboutP2')}</p>
        <p>
          {t('pages2.scienceIntro')}{' '}
          <Link to="/science" className="text-cyan underline underline-offset-2">
            {t('pages2.scienceLink')}
          </Link>
        </p>
      </Section>
      <Section id="challenge" title={t('pages2.challengeTitle')}>
        <p>{t('pages2.challengeBody')}</p>
      </Section>
      <Section id="ack" title={t('pages.ackTitle')}>
        <p>{t('pages.ackIntro')}</p>
        <dl className="flex flex-col gap-3">
          {acks.map((k) => (
            <div key={k}>
              <dt className="font-semibold text-text">{t(`pages.ack.${k}.t`)}</dt>
              <dd>{t(`pages.ack.${k}.d`)}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section id="priv" title={t('pages.privTitle')}>
        <dl className="flex flex-col gap-3">
          {priv.map((k) => (
            <div key={k}>
              <dt className="font-semibold text-text">{t(`pages.priv.${k}.t`)}</dt>
              <dd>
                {k === 'reports'
                  ? contactAddr
                    ? t('pages.priv.reports.d', { addr: contactAddr })
                    : t('pages.priv.reports.dNoAddr')
                  : t(`pages.priv.${k}.d`)}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section id="team" title={t('pages2.teamTitle')}>
        <p>{t('pages2.teamBody')}</p>
        <p>
          {t('pages2.licenceBody')}{' '}
          <a
            href="https://github.com/felicabrera/destello"
            className="text-cyan underline underline-offset-2"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('pages2.sourceLink')}
          </a>
        </p>
      </Section>
      <Section id="nonendorse" title={t('pages2.nonEndorseTitle')}>
        <p data-testid="non-endorsement">{t('pages2.nonEndorse')}</p>
      </Section>
    </PageShell>
  );
}
