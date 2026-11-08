/** Variable input for builds and normaliseVars; low-level SVG Maps must already be normalized. */
export type SvgVariables = Record<string, string | number> | Map<string, string | number>;

/**
 * How hard a build works on each raster. `'fast'`: one encode at quality 80, no search, no
 * Zopfli. `'default'`: a binary search for the smallest encode that passes the accuracy bar,
 * then Zopfli at 15 iterations. `'max'`: every candidate, then Zopfli at 120 iterations.
 */
export type Effort = 'fast' | 'default' | 'max';

/** Image options shared by Node, Vite and Astro. Ranges are checked at runtime. */
export interface ImageOptions {
  /** Pins a palette ceiling, 2-256, at quality 100: one encode, no search. Default: chosen per raster by the search. */
  colors?: number;
  /** Pins a PNG quality, integer 1-100, at the full palette: one encode, no search. Below 100 cannot combine with colors. Default: chosen per raster by the search. */
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
  /** How hard to work on each raster. Default: `'default'`. Dev builds in Vite and Astro use `'fast'`. */
  effort?: Effort;
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
