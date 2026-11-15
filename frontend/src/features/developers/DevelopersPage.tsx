// F-36 /developers: API endpoints read from the OpenAPI document, embed, URL contract, rate limits,
// the data resources register (generated from docs/17) and the credits.
/* A read-only code box must be focusable so keyboard users can scroll it. */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { API_BASE, getOpenApi } from '../../lib/api';
import { useBackend } from '../../lib/backend';
import { PageShell, Section } from '../pages/PageShell';
import resources from './dataResources.json';
import {
  RATE_LIMITS,
  URL_EXAMPLE,
  URL_PARAMS,
  embedSnippet,
  endpointsByTag,
  type OpenApiDoc,
} from './developersModel';
import { Inline } from './inlineMarkdown';

const ORIGIN = typeof window === 'undefined' ? '' : window.location.origin;
const OPENAPI_URL = `${API_BASE}/openapi.json`;

const kbd = 'rounded-xs bg-surface-2 px-1 font-mono text-caption-12';

function Endpoints() {
  const { t } = useTranslation('developers');
  const mode = useBackend((s) => s.mode);
  const probed = useBackend((s) => s.probed);
  const q = useQuery({
    queryKey: ['openapi', mode],
    queryFn: () => getOpenApi<OpenApiDoc>(),
    enabled: probed && mode !== 'demo',
    retry: false,
    staleTime: 600_000,
  });
  const failed = (probed && mode === 'demo') || q.isError;
  const url = `${ORIGIN}${OPENAPI_URL}`;
  return (
    <>
      <p>{t('api.body', { url, docs: `${ORIGIN}/api/docs` })}</p>
      {!failed && !q.data && (
        <p role="status" className="text-muted" data-testid="api-loading">
          {t('api.loading')}
        </p>
      )}
      {failed && (
        <p
          role="alert"
          className="rounded-lg border border-border-strong bg-surface p-3"
          data-testid="api-error"
        >
          {t('api.error', { url })}
        </p>
      )}
      {q.data && (
        <div data-testid="api-endpoints" className="flex flex-col gap-5">
          {q.data.info?.version && (
            <p className="text-label-13 text-muted">
              {t('api.version', { title: q.data.info.title ?? '', version: q.data.info.version })}
            </p>
          )}
          {endpointsByTag(q.data).map(([tag, list]) => (
            <div key={tag}>
              <h3 className="text-label-13 font-semibold uppercase tracking-wider text-muted">
                {tag || t('api.untagged')}
              </h3>
              <ul
                aria-label={t('api.region', { tag: tag || t('api.untagged') })}
                className="mt-2 flex flex-col gap-2"
              >
                {list.map((e) => (
                  <li
                    key={`${e.method} ${e.path}`}
                    className="rounded-lg border border-border bg-surface p-3"
                    data-testid="api-endpoint"
                  >
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="tnum rounded-xs bg-surface-2 px-1.5 font-mono text-caption-12 font-semibold text-glint">
                        {e.method}
                      </span>
                      <code className="break-all font-mono text-label-13 text-text">{e.path}</code>
                    </p>
                    {(e.description || e.summary) && (
                      <p className="mt-1 text-body-14 text-text-2">{e.description || e.summary}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Resources() {
  const { t } = useTranslation('developers');
  const fields = [
    'provider',
    'official',
    'host',
    'access',
    'usage',
    'version',
    'licence',
    'acknowledgement',
  ] as const;
  return (
    <>
      <p>{t('resources.body')}</p>
      <h3 className="text-label-13 font-semibold uppercase tracking-wider text-muted">
        {t('resources.register')}
      </h3>
      <ul aria-label={t('resources.caption')} className="flex flex-col gap-3" data-testid="resources">
        {resources.register.map((r) => (
          <li key={r.name} className="rounded-lg border border-border bg-surface p-4" data-testid="resource">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h4 className="min-w-0 break-words text-title-20 font-medium text-text">{r.name}</h4>
              <p className="text-caption-12 text-muted">
                {t('resources.status')}: <span className="text-text-2">{r.status}</span>
              </p>
            </div>
            {/not verified/i.test(`${r.licence} ${r.acknowledgement}`) && (
              <p className="mt-1 text-caption-12 text-warning">{t('resources.unverified')}</p>
            )}
            <dl className="mt-3 flex flex-col gap-2 text-body-14">
              {fields.map((f) => (
                <div key={f}>
                  <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
                    {t(`resources.${f}`)}
                  </dt>
                  <dd className="break-words text-text-2">
                    <Inline text={r[f]} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <h3 className="mt-2 text-label-13 font-semibold uppercase tracking-wider text-muted">
        {t('resources.terms')}
      </h3>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-body-14">
        {resources.terms.map((x) => (
          <li key={x.title} className="break-words">
            <strong className="font-semibold text-text">{x.title}</strong> <Inline text={x.text} />
          </li>
        ))}
      </ol>
    </>
  );
}

export function DevelopersPage() {
  const { t } = useTranslation('developers');
  const ids = ['python', 'api', 'embed', 'url', 'limits', 'resources', 'credits'] as const;
  const toc = ids.map((id) => ({ id, label: t(`sections.${id}`) }));
  const title = 'Destello';
  return (
    <PageShell
      kicker={t('kicker')}
      title={t('title')}
      lead={t('lead')}
      toc={toc}
      tocLabel={t('toc')}
      testId="developers"
    >
      <Section id="python" n={1} title={t('sections.python')}>
        <p>{t('python.body')}</p>
        <p>{t('python.how')}</p>
        <code className={`${kbd} break-all`}>{t('python.endpoint')}</code>
      </Section>
      <Section id="api" n={2} title={t('sections.api')}>
        <Endpoints />
      </Section>
      <Section id="embed" n={3} title={t('sections.embed')}>
        <p>{t('embed.body')}</p>
        <pre
          tabIndex={0}
          aria-label={t('embed.snippetLabel')}
          className="max-w-full overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-caption-12 text-text"
          data-testid="embed-code"
        >
          {embedSnippet(ORIGIN, title)}
        </pre>
      </Section>
      <Section id="url" n={4} title={t('sections.url')}>
        <p>{t('url.body')}</p>
        <ul className="flex flex-col gap-2" data-testid="url-params">
          {URL_PARAMS.map((p) => (
            <li key={p.id} className="rounded-lg border border-border bg-surface p-3">
              <p className="flex flex-wrap items-baseline gap-x-3">
                <code className="font-mono text-label-13 font-semibold text-text">{p.names}</code>
                <span className="break-words text-caption-12 text-muted">
                  {t('url.values')}: {p.values}
                </span>
              </p>
              <p className="mt-1 text-body-14 text-text-2">{t(`url.rows.${p.id}`)}</p>
            </li>
          ))}
        </ul>
        <p className="break-all text-body-14">
          {t('url.example')}: <code className={kbd}>{URL_EXAMPLE}</code>
        </p>
      </Section>
      <Section id="limits" n={5} title={t('sections.limits')}>
        <p>{t('limits.body')}</p>
        <ul className="flex flex-col gap-2" data-testid="rate-limits">
          {RATE_LIMITS.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border bg-surface p-3"
            >
              <span className="min-w-0 break-words text-body-14 text-text-2">{t(`limits.rows.${r.id}`)}</span>
              <span className="tnum text-label-13 font-semibold text-text">
                {t(`limits.${r.unit}`, { n: r.n })}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section id="resources" n={6} title={t('sections.resources')}>
        <Resources />
      </Section>
      <Section id="credits" n={7} title={t('sections.credits')}>
        <p>{t('credits.body')}</p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            {t('credits.spherex')}{' '}
            <a
              className="break-all text-cyan underline underline-offset-2"
              href="https://caltech-ipac.github.io/irsa-tutorials/spherex/"
              target="_blank"
              rel="noopener noreferrer"
            >
              caltech-ipac.github.io/irsa-tutorials/spherex
            </a>
          </li>
          <li>
            {t('credits.wiseview')}{' '}
            <a
              className="break-all text-cyan underline underline-offset-2"
              href="https://byw.tools"
              target="_blank"
              rel="noopener noreferrer"
            >
              byw.tools
            </a>
          </li>
          <li>
            {t('credits.neossat')}{' '}
            <a
              className="break-all text-cyan underline underline-offset-2"
              href="https://github.com/asc-csa/NEOSSAT_Tutorial"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/asc-csa/NEOSSAT_Tutorial
            </a>
          </li>
        </ul>
      </Section>
    </PageShell>
  );
}
