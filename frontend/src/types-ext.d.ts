// Ambient declarations for packages that ship without types.
declare module 'plotly.js-basic-dist-min' {
  import Plotly from 'plotly.js';
  export default Plotly;
}

declare module 'gifenc' {
  /* Minimal surface used by lib/exportGif. */
  export type Palette = number[][];
  export interface Encoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; delay?: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): Palette;
  export function nearestColorIndex(palette: Palette, pixel: number[]): number;
}

declare module 'aladin-lite' {
  /* Minimal surface used by ContextPanel. */
  export interface AladinInstance {
    setFoV(fovDeg: number): void;
    gotoRaDec(ra: number, dec: number): void;
    setImageSurvey(id: string): void;
    addOverlay?(o: unknown): void;
    removeLayers?(): void;
  }
  const A: {
    init: Promise<void>;
    aladin(el: HTMLElement | string, opts?: Record<string, unknown>): AladinInstance;
    graphicOverlay(opts?: Record<string, unknown>): { addFootprints(f: unknown[]): void; removeAll(): void };
    polygon(pts: [number, number][], opts?: Record<string, unknown>): unknown;
  };
  export default A;
}
