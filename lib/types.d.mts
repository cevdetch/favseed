/** Variable input for builds and normaliseVars; low-level SVG Maps must already be normalized. */
export type SvgVariables = Record<string, string | number> | Map<string, string | number>;

/** Image options shared by Node, Vite and Astro. Ranges are checked at runtime. */
export interface ImageOptions {
  /** Explicit palette ceiling, 2-256. Selects quality 100 when quality is omitted. */
  colors?: number;
  /** PNG quality target, integer 1-100. Default 80, or 100 when colors is supplied alone. Below 100 cannot combine with colors; not an error percentage or a file-size guarantee. */
  quality?: number;
  /** Padded "any maskable" PNG sizes, even pixel counts. Default: `[192, 512]`. */
  sizes?: number[];
  /** Ground of the padded icons. `null` (or `'none'`) keeps the set transparent and unpadded, declared `"any"` only. Default: `'#000000'`. */
  bg?: string | null;
  /** Margin of each padded icon, as a percentage per side. Default: `'auto'`, measured per mark. */
  padding?: number | 'auto';
  /** CSS custom properties, with or without the leading `--`. */
  vars?: SvgVariables;
  /** `false` explicitly removes animation from icon.svg. Default: preserve it. */
  animation?: boolean;
  /** `true` writes an icons-only site.webmanifest; an object's members are merged in ahead of the icons. */
  manifest?: boolean | Record<string, unknown>;
  /** Zopfli effort when enabled: `'release'` uses 120 iterations; `'fast'` uses 15. */
  mode?: 'release' | 'fast';
  /** Extra lossless PNG compression. Slower; disabled by default. */
  zopfli?: boolean;
}

/** Decoded pixels in row-major RGBA order, four bytes per pixel. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export interface PlacementMetrics {
  box: number;
  scale: number;
  snapped: boolean;
  radius: number | null;
  fullBleed: boolean;
  padding: number;
}

/** Placement reported by a full build, including the output canvas size. */
export interface Placement extends PlacementMetrics {
  canvas: number;
}
