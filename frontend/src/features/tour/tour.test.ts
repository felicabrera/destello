import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import es from '../../i18n/es.json';
import { TOUR_STEPS, nextStep, placeCard, prevStep, unionBox } from './tourSteps';
import { TOUR_SEEN_KEY, createSeenFlag, createTourStore } from './useTour';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return Array.from(this.m.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const throwing = (): Storage => {
  throw new Error('SecurityError');
};

describe('TOUR_STEPS', () => {
  it('walks from the player to sharing in nine steps', () => {
    expect(TOUR_STEPS.map((s) => s.key)).toEqual([
      'player',
      'search',
      'transport',
      'detector',
      'mode',
      'overlays',
      'results',
      'motion',
      'share',
    ]);
    for (const s of TOUR_STEPS) expect(s.anchors.length).toBeGreaterThan(0);
  });

  it('has a title and a body in both languages for every step', () => {
    const tours = [en.tour, es.tour] as { steps: Record<string, { title: string; body: string }> }[];
    for (const tour of tours)
      for (const s of TOUR_STEPS) {
        expect(tour.steps[s.key]?.title).toBeTruthy();
        expect(tour.steps[s.key]?.body).toBeTruthy();
      }
  });

  it('uses no dashes as separators, curly quotes or the word discovery in its copy', () => {
    const text = JSON.stringify([en.tour, es.tour]);
    expect(text).not.toMatch(/[–—‘’“”]/);
    expect(text.toLowerCase()).not.toMatch(/discover|descubr/);
  });
});

describe('step navigation', () => {
  it('moves forward and ends after the last step', () => {
    expect(nextStep(0, 9)).toBe(1);
    expect(nextStep(8, 9)).toBeNull();
    expect(prevStep(0)).toBe(0);
    expect(prevStep(3)).toBe(2);
  });

  it('frames every visible anchor and ignores hidden ones', () => {
    expect(
      unionBox([
        { x: 10, y: 10, w: 20, h: 20 },
        { x: 50, y: 0, w: 10, h: 10 },
        { x: 0, y: 0, w: 0, h: 0 },
      ]),
    ).toEqual({ x: 10, y: 0, w: 50, h: 30 });
    expect(unionBox([{ x: 0, y: 0, w: 0, h: 5 }])).toBeNull();
  });

  it('moves the card away from an anchor at the bottom when no side has room', () => {
    expect(placeCard({ x: 0, y: 360, w: 360, h: 380 }, { w: 328, h: 340 }, 360, 740).top).toBe(16);
    expect(placeCard({ x: 0, y: 0, w: 360, h: 380 }, { w: 328, h: 340 }, 360, 740).top).toBe(384);
  });

  it('keeps the card inside a 360 px viewport', () => {
    const p = placeCard({ x: 16, y: 60, w: 328, h: 328 }, { w: 328, h: 300 }, 360, 640);
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(p.left + 328).toBeLessThanOrEqual(360 - 16);
  });
});

describe('seen flag', () => {
  it('stores the flag in localStorage', () => {
    const local = new MemStorage();
    const flag = createSeenFlag([() => local]);
    expect(flag.read()).toBe(false);
    flag.write();
    expect(local.getItem(TOUR_SEEN_KEY)).toBe('1');
    expect(createSeenFlag([() => local]).read()).toBe(true);
  });

  it('falls back to sessionStorage when localStorage throws', () => {
    const session = new MemStorage();
    const flag = createSeenFlag([throwing, () => session]);
    expect(flag.read()).toBe(false);
    flag.write();
    expect(session.getItem(TOUR_SEEN_KEY)).toBe('1');
    expect(createSeenFlag([throwing, () => session]).read()).toBe(true);
  });

  it('keeps the flag in memory when every storage throws', () => {
    const flag = createSeenFlag([throwing, throwing]);
    expect(flag.read()).toBe(false);
    expect(() => flag.write()).not.toThrow();
    expect(flag.read()).toBe(true);
  });
});

describe('tour store', () => {
  it('opens once on the first visit and not again in the same page load', () => {
    const local = new MemStorage();
    const store = createTourStore(createSeenFlag([() => local]), 3);
    store.getState().maybeAutoStart();
    expect(store.getState().step).toBe(0);
    store.getState().close('skip');
    expect(store.getState().step).toBeNull();
    store.getState().maybeAutoStart();
    expect(store.getState().step).toBeNull();
    expect(local.getItem(TOUR_SEEN_KEY)).toBe('1');
  });

  it('does not open by itself once seen, but replays on request', () => {
    const local = new MemStorage();
    local.setItem(TOUR_SEEN_KEY, '1');
    const store = createTourStore(createSeenFlag([() => local]), 3);
    store.getState().maybeAutoStart();
    expect(store.getState().step).toBeNull();
    store.getState().start();
    expect(store.getState().step).toBe(0);
  });

  it('marks the tour seen when it is finished with Next', () => {
    const local = new MemStorage();
    const store = createTourStore(createSeenFlag([() => local]), 3);
    store.getState().start();
    store.getState().next();
    store.getState().back();
    expect(store.getState().step).toBe(0);
    store.getState().next();
    store.getState().next();
    expect(store.getState().step).toBe(2);
    expect(local.getItem(TOUR_SEEN_KEY)).toBeNull();
    store.getState().next();
    expect(store.getState().step).toBeNull();
    expect(local.getItem(TOUR_SEEN_KEY)).toBe('1');
  });

  it('shows at most once per page load when storage is unavailable', () => {
    const store = createTourStore(createSeenFlag([throwing, throwing]), 3);
    store.getState().maybeAutoStart();
    expect(store.getState().step).toBe(0);
    store.getState().close('skip');
    store.getState().maybeAutoStart();
    expect(store.getState().step).toBeNull();
  });
});
