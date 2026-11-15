import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { ExplorerPage } from './features/explorer/ExplorerPage';
import { useTour } from './features/tour/useTour';
import { useTargets, useView } from './features/explorer/useView';
import { Footer } from './features/layout/Footer';
import { Header } from './features/layout/Header';
import { setLanguage } from './i18n';
import { isDemo, useBackend } from './lib/backend';
import { NotFoundPage } from './features/errors/NotFoundPage';
import { RouteError } from './features/errors/RouteError';
import { useSeoManager } from './lib/seo';
import { parseSearch, stringifySearch, validateSearch } from './lib/url-state';

// Pages off the main explorer path load on demand, so the first visit downloads less.
const EmbedPage = lazyRouteComponent(() => import('./features/explorer/EmbedPage'), 'EmbedPage');
const SciencePage = lazyRouteComponent(() => import('./features/pages/StaticPages'), 'SciencePage');
const ValidationPage = lazyRouteComponent(() => import('./features/pages/StaticPages'), 'ValidationPage');
const AboutPage = lazyRouteComponent(() => import('./features/pages/StaticPages'), 'AboutPage');
const HuntPage = lazyRouteComponent(() => import('./features/hunt/HuntPage'), 'HuntPage');
const StoryPage = lazyRouteComponent(() => import('./features/story/StoryPage'), 'StoryPage');
const CometPage = lazyRouteComponent(() => import('./features/comet/CometPage'), 'CometPage');
const LearnPage = lazyRouteComponent(() => import('./features/learn/LearnPage'), 'LearnPage');
const LearnGuide = lazyRouteComponent(() => import('./features/learn/LearnGuide'), 'LearnGuide');
const DevelopersPage = lazyRouteComponent(
  () => import('./features/developers/DevelopersPage'),
  'DevelopersPage',
);
const ReportPage = lazyRouteComponent(() => import('./features/report/ReportPage'), 'ReportPage');
import { useTranslation } from 'react-i18next';

function RootLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const embed = pathname.startsWith('/embed');
  const explorer = pathname === '/' || pathname.startsWith('/t/');
  const startTour = useTour((s) => s.start);
  const v = useView();
  const targets = useTargets().data;
  const mode = useBackend((s) => s.mode);

  useEffect(() => {
    setLanguage(v.view.lang);
  }, [v.view.lang]);
  useSeoManager(pathname, v.view.lang);

  if (embed) return <Outlet />;
  void router;
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a
        href="#main"
        className="sr-live focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('app.skip')}
      </a>
      <Header
        lang={v.view.lang}
        onLang={v.setLang}
        targets={targets}
        demo={isDemo(mode)}
        onOpenPreset={v.openPreset}
        onOpenPath={v.openPath}
        onTour={explorer ? startTour : undefined}
      />
      {/* Each page renders its own <main id="main"> (the skip link target). */}
      <div className="flex-1">
        <Outlet />
      </div>
      <Footer />
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });
const opts = {
  getParentRoute: () => rootRoute,
  validateSearch: (s: Record<string, unknown>) => validateSearch(s),
};
const indexRoute = createRoute({ ...opts, path: '/', component: ExplorerPage });
const targetRoute = createRoute({ ...opts, path: '/t/$target', component: ExplorerPage });
const embedRoute = createRoute({ ...opts, path: '/embed', component: EmbedPage });
const scienceRoute = createRoute({ ...opts, path: '/science', component: SciencePage });
const validationRoute = createRoute({ ...opts, path: '/validation', component: ValidationPage });
const aboutRoute = createRoute({ ...opts, path: '/about', component: AboutPage });
const huntRoute = createRoute({ ...opts, path: '/hunt', component: HuntPage });
const storyRoute = createRoute({ ...opts, path: '/story', component: StoryPage });
const cometRoute = createRoute({ ...opts, path: '/comet', component: CometPage });
const learnRoute = createRoute({ ...opts, path: '/learn', component: LearnPage });
const learnGuideRoute = createRoute({ ...opts, path: '/learn/guide', component: LearnGuide });
const developersRoute = createRoute({ ...opts, path: '/developers', component: DevelopersPage });
const reportRoute = createRoute({ ...opts, path: '/r/$reportId', component: ReportPage });

// Development only (removed from production builds): throws while rendering, to exercise the error page.
function CrashPage(): never {
  throw new Error('Injected render error');
}
const crashRoute = createRoute({ ...opts, path: '/__crash', component: CrashPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  targetRoute,
  embedRoute,
  scienceRoute,
  validationRoute,
  aboutRoute,
  huntRoute,
  storyRoute,
  cometRoute,
  learnRoute,
  learnGuideRoute,
  developersRoute,
  reportRoute,
  ...(import.meta.env.DEV ? [crashRoute] : []),
]);

export const router = createRouter({
  routeTree,
  parseSearch: (s) => parseSearch(s),
  stringifySearch: (o) => stringifySearch(o),
  defaultPreload: false,
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
