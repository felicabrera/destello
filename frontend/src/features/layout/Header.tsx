import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { cn } from '../../lib/cn';
import type { Lang, TargetItem } from '../../lib/types';
import { BuildsIndicator } from '../build/BuildsIndicator';
import { SearchBox } from '../search/SearchBox';

interface Props {
  lang: Lang;
  onLang: (l: Lang) => void;
  targets: TargetItem[] | undefined;
  demo: boolean;
  onOpenPreset: (id: string) => void;
  onOpenPath: (path: string) => void;
  /** F-24: replays the guided tour; given only on Explorer pages. */
  onTour?: () => void;
  /** Search is hidden on pages without an explorer (still shown, but routes to the explorer). */
}

/** Shown in the bar at desktop widths. */
const PRIMARY = [
  { to: '/story', key: 'story:nav' },
  { to: '/hunt', key: 'hunt:nav' },
  { to: '/learn', key: 'learn:nav' },
] as const;

/** Behind the "More" menu at desktop widths, and in the footer. */
export const SECONDARY = [
  { to: '/science', key: 'app.nav.science' },
  { to: '/validation', key: 'app.nav.validation' },
  { to: '/about', key: 'app.nav.about' },
  { to: '/developers', key: 'developers:nav' },
] as const;

function linkCls(active: boolean) {
  return cn(
    'flex min-h-[var(--hit-min)] items-center rounded-lg px-3 text-body-14 font-medium transition-colors duration-(--duration-fast)',
    active ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text',
  );
}

export function Header({ lang, onLang, targets, demo, onOpenPreset, onOpenPath, onTour }: Props) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const other: Lang = lang === 'en' ? 'es' : 'en';
  const moreRef = useRef<HTMLButtonElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu]);

  return (
    <header
      className={
        searchOpen ? 'relative z-[60] border-b border-border' : 'relative z-20 border-b border-border'
      }
      data-testid="header"
    >
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 md:h-16 md:gap-6 md:px-6 xl:px-8">
        <Link
          to="/"
          aria-label={t('app.name')}
          className="flex flex-none cursor-pointer select-none items-center rounded-md"
          data-testid="logo"
        >
          <span className="hidden md:block">
            <img
              src="/brand/destello-horizontal-color-dark.svg"
              alt=""
              height={28}
              draggable={false}
              className="only-dark h-7 w-auto"
            />
            <img
              src="/brand/destello-horizontal-color-light.svg"
              alt=""
              height={28}
              draggable={false}
              className="only-light h-7 w-auto"
            />
          </span>
          <img
            src="/brand/destello-mark-color-dark.svg"
            alt=""
            width={28}
            height={28}
            className="size-7 md:hidden"
          />
        </Link>

        <div className="hidden min-w-0 flex-1 md:block md:max-w-[420px] lg:max-w-[560px]" data-tour="search">
          <SearchBox targets={targets} demo={demo} onOpenPreset={onOpenPreset} onOpenPath={onOpenPath} />
        </div>
        <div className="flex-1 md:hidden" />

        <nav aria-label="Destello" className="ml-auto hidden items-center gap-1 lg:flex">
          {PRIMARY.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={linkCls(false)}
              activeProps={{ className: linkCls(true), 'aria-current': 'page' }}
            >
              {t(n.key)}
            </Link>
          ))}
          <button
            ref={moreRef}
            type="button"
            className={linkCls(menu)}
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            data-testid="more-toggle"
          >
            {t('app.more')}
          </button>
        </nav>

        <BuildsIndicator onOpenPath={onOpenPath} />

        <button
          type="button"
          className="grid min-h-[var(--hit-min)] min-w-[var(--hit-min)] place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text md:hidden"
          aria-label={t('search.button')}
          onClick={() => setSearchOpen(true)}
          data-testid="open-search"
          data-tour="search"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => onLang(other)}
          lang={other}
          title={`${t('app.language')}: ${other.toUpperCase()}`}
          className="tnum flex min-h-[var(--hit-min)] items-center gap-0.5 rounded-lg border border-border bg-bg p-0.5 text-label-13 font-semibold hover:bg-surface-2"
          data-testid="lang-toggle"
        >
          <span className="sr-only">{t('app.language')}: </span>
          {(['en', 'es'] as const).map((l) => (
            <span
              key={l}
              className={`grid min-h-7 min-w-8 place-items-center rounded-md px-2 ${l === lang ? 'bg-surface-2 text-text' : 'text-muted'}`}
              aria-current={l === lang ? 'true' : undefined}
            >
              {l.toUpperCase()}
            </span>
          ))}
        </button>

        <button
          ref={burgerRef}
          type="button"
          className="grid min-h-[var(--hit-min)] min-w-[var(--hit-min)] place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden"
          aria-label={t('app.menu')}
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          data-testid="menu-toggle"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>

      {menu && (
        <nav
          aria-label="Destello"
          className="absolute inset-x-0 top-full z-30 flex flex-col border-b border-border bg-surface px-4 py-2 lg:left-auto lg:right-6 lg:mt-1 lg:w-56 lg:rounded-lg lg:border lg:px-2"
          data-testid="mobile-nav"
        >
          {[...PRIMARY, ...SECONDARY].map((n, i) => (
            <Link
              key={n.to}
              to={n.to}
              className={cn(linkCls(false), i < PRIMARY.length && 'lg:hidden')}
              activeProps={{ 'aria-current': 'page' }}
              onClick={() => setMenu(false)}
            >
              {t(n.key)}
            </Link>
          ))}
          {onTour && (
            <button
              type="button"
              className={linkCls(false)}
              onClick={() => {
                setMenu(false);
                // The menu item unmounts: the tour returns focus to the control that opened the menu.
                const opener = [moreRef.current, burgerRef.current].find((el) => el?.offsetParent);
                opener?.focus();
                onTour();
              }}
              data-testid="tour-replay-menu"
            >
              {t('tour.replay')}
            </button>
          )}
        </nav>
      )}

      {searchOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col gap-3 bg-bg p-4 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t('search.label')}
          data-testid="search-overlay"
        >
          <div className="flex flex-col-reverse gap-2">
            <SearchBox
              className="w-full"
              targets={targets}
              demo={demo}
              focusOnMount
              onOpenPreset={onOpenPreset}
              onOpenPath={onOpenPath}
              onDone={() => setSearchOpen(false)}
            />
            <button
              type="button"
              className="min-h-[var(--hit-min)] self-end rounded-lg px-3 text-label-13 font-medium text-muted hover:bg-surface-2"
              onClick={() => setSearchOpen(false)}
            >
              {t('sheet2.closeSearch')}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
