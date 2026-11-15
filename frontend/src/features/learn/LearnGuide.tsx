// F-38: printable teacher guide, one page per language. On screen it is an ordinary page; the print rules hide the
// site header and footer and print black on white. The answer range is computed from the API (catalog motion,
// manifest pixel scale and time span), never typed; with a value missing the sentence is left out.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/button';
import { localNumber } from '../../lib/format';
import { localUnit } from '../../lib/units';
import { useView } from '../explorer/useView';
import { answerRange, bestBaseline } from './learnModel';
import { LEARN_TARGET, useLearnReference, useSequenceManifest } from './useLearnReference';

/** Minutes of each part of the lesson; they add up to the length of the lesson (checked in the tests). */
export const TIMELINE = [
  { id: 'intro', minutes: 5 },
  { id: 'look', minutes: 5 },
  { id: 'click', minutes: 10 },
  { id: 'calc', minutes: 10 },
  { id: 'compare', minutes: 10 },
] as const;
export const LESSON_MINUTES = TIMELINE.reduce((s, x) => s + x.minutes, 0);

const PRINT_CSS = `
@media print {
  [data-testid="header"], [data-testid="footer"], [data-noprint] { display: none !important; }
  html, body { background: white !important; color: black !important; }
  [data-testid="learn-guide"] { max-width: none !important; padding: 0 !important; color: black !important; }
  [data-testid="learn-guide"] * { color: black !important; background: transparent !important; border-color: black !important; box-shadow: none !important; }
  [data-testid="learn-guide"] section { break-inside: avoid; }
  [data-testid="learn-guide"] a { text-decoration: none; }
  @page { margin: 18mm; }
}
`;

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={`flex flex-col gap-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </Tag>
  );
}

export function LearnGuide() {
  const { t } = useTranslation('learn');
  const { t: tt } = useTranslation();
  const v = useView();
  const lang = v.view.lang;
  const seqId = v.targets?.find((x) => x.id === LEARN_TARGET)?.sequence_id ?? null;
  const manifest = useSequenceManifest(seqId);
  const base = useMemo(() => (manifest.data ? bestBaseline(manifest.data.epochs) : null), [manifest.data]);
  const ref = useLearnReference(seqId, base?.det ?? null);
  const reference = ref.gaia?.total ?? ref.destello?.total ?? null;
  const range = answerRange(reference, manifest.data?.grid.pixel_scale_arcsec, base?.years);
  const N = (n: number, d: number) => localNumber(lang, n, d);
  const unit = localUnit(tt, 'arcsec/yr');
  const arr = (key: string) => t(key, { returnObjects: true }) as string[];

  return (
    <main
      id="main"
      tabIndex={-1}
      className="learn-guide mx-auto flex max-w-[820px] flex-col gap-6 px-4 py-8 text-body-15 text-text-2 md:px-6"
      data-testid="learn-guide"
    >
      <style>{PRINT_CSS}</style>
      <header className="flex flex-col gap-2">
        <p className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
          {t('guide.kicker')}
        </p>
        <h1 className="font-display text-heading-24 font-medium text-text md:text-display-32">
          {t('guide.title')}
        </h1>
        <p>{t('guide.lead')}</p>
        <div className="flex flex-wrap gap-2" data-noprint>
          <Button variant="primary" onClick={() => window.print()} data-testid="guide-print">
            {t('guide.print')}
          </Button>
          <Link
            to="/learn"
            search={{ lang }}
            className="inline-flex min-h-[var(--hit-min)] items-center rounded-lg px-3 text-label-13 font-medium text-glint underline underline-offset-2"
          >
            {t('guide.open')}
          </Link>
        </div>
      </header>

      <section aria-labelledby="g-obj" className="flex flex-col gap-2" data-testid="guide-objectives">
        <h2 id="g-obj" className="text-title-20 font-semibold text-text">
          {t('guide.objectives')}
        </h2>
        <List items={arr('guide.objectiveList')} />
      </section>

      <section aria-labelledby="g-time" className="flex flex-col gap-2" data-testid="guide-timeline">
        <h2 id="g-time" className="text-title-20 font-semibold text-text">
          {t('guide.timeline', { minutes: LESSON_MINUTES })}
        </h2>
        <table className="w-full text-left text-body-14">
          <thead className="text-label-13 text-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('guide.minutesCol')}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t('guide.partCol')}
              </th>
            </tr>
          </thead>
          <tbody>
            {TIMELINE.map((p) => (
              <tr key={p.id} className="border-t border-border align-top">
                <td className="tnum py-1.5 pr-3 font-medium text-text">
                  {t('guide.minutes', { n: p.minutes })}
                </td>
                <td className="py-1.5">
                  <span className="font-medium text-text">{t(`guide.parts.${p.id}.title`)}</span>
                  <span className="block">{t(`guide.parts.${p.id}.body`)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="g-mat" className="flex flex-col gap-2" data-testid="guide-materials">
        <h2 id="g-mat" className="text-title-20 font-semibold text-text">
          {t('guide.materials')}
        </h2>
        <List items={arr('guide.materialList')} />
      </section>

      <section aria-labelledby="g-steps" className="flex flex-col gap-2" data-testid="guide-steps">
        <h2 id="g-steps" className="text-title-20 font-semibold text-text">
          {t('guide.steps')}
        </h2>
        <List ordered items={arr('guide.stepList')} />
      </section>

      <section aria-labelledby="g-q" className="flex flex-col gap-2" data-testid="guide-questions">
        <h2 id="g-q" className="text-title-20 font-semibold text-text">
          {t('guide.questions')}
        </h2>
        <List ordered items={arr('guide.questionList')} />
      </section>

      <section aria-labelledby="g-ans" className="flex flex-col gap-2" data-testid="guide-answer">
        <h2 id="g-ans" className="text-title-20 font-semibold text-text">
          {t('guide.answer')}
        </h2>
        {range && base && manifest.data ? (
          <>
            <p data-testid="guide-range">
              {t('guide.range', {
                low: N(range.low, 1),
                high: N(range.high, 1),
                center: N(range.center, 2),
                unit,
              })}
            </p>
            <p className="text-body-14">
              {t('guide.rangeWhy', {
                px: N(manifest.data.grid.pixel_scale_arcsec, 1),
                years: N(base.years, 2),
              })}
            </p>
          </>
        ) : (
          <p data-testid="guide-range-missing">
            {ref.pending || manifest.isPending ? t('loading') : t('guide.rangeMissing')}
          </p>
        )}
      </section>
    </main>
  );
}
