import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export interface TocItem {
  id: string;
  label: string;
}

/** Editorial shell shared by Science and About: section rail on wide screens, one reading column. */
export function PageShell({
  kicker,
  title,
  lead,
  toc,
  tocLabel,
  children,
  testId = 'page',
}: {
  kicker: string;
  title: string;
  lead?: string;
  toc: TocItem[];
  tocLabel: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto grid max-w-[1100px] gap-10 px-4 py-10 md:px-6 lg:grid-cols-[200px_minmax(0,680px)] xl:gap-16"
      data-testid={testId}
    >
      <nav aria-label={tocLabel} className="hidden lg:block">
        <div className="sticky top-6">
          <p className="text-caption-12 font-semibold uppercase tracking-wider text-muted">{tocLabel}</p>
          <ol className="mt-3 flex flex-col gap-1">
            {toc.map((x, i) => (
              <li key={x.id}>
                <a
                  href={`#${x.id}`}
                  className="tnum flex min-h-[var(--hit-min)] items-center gap-2 rounded-md px-2 text-label-13 text-muted hover:bg-surface-2 hover:text-text"
                >
                  <span className="text-caption-12">{String(i + 1).padStart(2, '0')}</span>
                  {x.label}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>
      <article className="flex min-w-0 flex-col gap-10">
        <header>
          <p className="text-caption-12 font-semibold uppercase tracking-wider text-glint">{kicker}</p>
          <h1 className="mt-1 font-display text-display-32 font-medium md:text-display-48">{title}</h1>
          {lead && <p className="mt-4 text-body-15 text-text-2 md:text-title-20">{lead}</p>}
        </header>
        {children}
        <p>
          <Link to="/" className="text-label-13 text-cyan underline underline-offset-2">
            {t('pages.back')}
          </Link>
        </p>
      </article>
    </main>
  );
}

export function Section({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n?: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 flex flex-col gap-3">
      <h2 id={`${id}-h`} className="font-display text-heading-24 font-medium text-text">
        {n !== undefined && (
          <span className="tnum mr-3 text-caption-12 text-muted">{String(n).padStart(2, '0')}</span>
        )}
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-body-15 text-text-2">{children}</div>
    </section>
  );
}
