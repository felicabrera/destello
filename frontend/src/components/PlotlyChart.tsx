import { useEffect, useRef, useState } from 'react';
import type { Config, Data, Layout } from 'plotly.js';
import { loadPlotly } from '../lib/plotly';

interface Props {
  data: Partial<Data>[];
  layout: Partial<Layout>;
  config: Partial<Config>;
  /** Accessible name; the same information is available in a table next to the plot. */
  label: string;
  height: number;
  testId?: string;
  className?: string;
}

/** Thin Plotly wrapper: lazy loads the library, redraws on data and theme changes, purges on unmount. */
export function PlotlyChart({ data, layout, config, label, height, testId, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPlotly()
      .then(async (P) => {
        if (cancelled || !ref.current) return;
        await P.react(
          ref.current,
          data as Data[],
          { uirevision: 'keep', ...layout, height, autosize: true },
          config,
        );
        if (!cancelled) setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
    // data, layout and config are rebuilt by the caller on every relevant change.
  }, [data, layout, config, height, themeTick]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) void loadPlotly().then((P) => P.purge(el));
    };
  }, []);

  return (
    <div className={className} data-testid={testId} data-state={state}>
      <div
        ref={ref}
        role="group"
        aria-label={label}
        // Opacity goes through style, never className: Plotly adds its own classes (js-plotly-plot) to this
        // element, and a React className update would strip them and break the chart layout.
        style={{ height, opacity: state === 'ready' ? undefined : 0 }}
      />
    </div>
  );
}
