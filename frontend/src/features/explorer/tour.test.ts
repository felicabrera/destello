import { describe, expect, it } from 'vitest';
import { placeCard } from '../tour/tourSteps';

// Card placement of the guided tour (features/tour). Step and persistence tests live in features/tour.
const card = { w: 360, h: 280 };

describe('placeCard', () => {
  it('puts the card to the right of the spotlight when there is room', () => {
    expect(placeCard({ x: 20, y: 120, w: 588, h: 588 }, card, 1440, 900)).toEqual({ left: 624, top: 120 });
  });
  it('falls back to the left, then below, and stays inside the viewport', () => {
    expect(placeCard({ x: 900, y: 100, w: 500, h: 300 }, card, 1440, 900).left).toBe(524);
    const below = placeCard({ x: 0, y: 40, w: 390, h: 300 }, card, 390, 844);
    expect(below.top).toBe(356);
    expect(below.left).toBe(16);
  });
  it('centers the card when the anchor is not on the page', () => {
    expect(placeCard(null, card, 1440, 900)).toEqual({ left: 540, top: 310 });
  });
});
