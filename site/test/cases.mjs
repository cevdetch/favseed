export const cases = [
  { name: 'small-mark/placement', mark: 'small-mark', options: { effort: 'fast' } },
  ...['aspect-wide', 'aspect-tall', 'aspect-offset', 'aspect-percent'].map((mark) => ({
    name: `${mark}/proportions`,
    mark,
    options: { effort: 'fast' },
  })),
  {
    name: 'aspect-percent/transparent',
    mark: 'aspect-percent',
    options: { bg: 'none', padding: 0, sizes: [32, 128], effort: 'fast' },
  },
  ...['grid-1', 'grid-16', 'grid-24', 'grid-tiny', 'grid-fallback'].map((mark) => ({
    name: `${mark}/precision`,
    mark,
    options: { effort: 'fast' },
  })),
  { name: 'gradient/quality100', mark: 'gradient', options: { quality: 100, effort: 'fast' } },
  { name: 'gradient/quality80', mark: 'gradient', options: { quality: 80, effort: 'fast' } },
  { name: 'gradient/quality60-default', mark: 'gradient', options: { quality: 60, effort: 'default', sizes: [32] } },
  ...['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'].map(
    (mark) => ({ name: `${mark}/fast`, mark, options: { effort: 'fast' } }),
  ),
  ...['tiles', 'gradient'].map((mark) => ({
    name: `${mark}/max`,
    mark,
    options: { effort: 'max' },
  })),
  { name: 'general/default', mark: 'general', options: { effort: 'default' } },
  { name: 'general/colors16-max', mark: 'general', options: { colors: 16, effort: 'max', sizes: [32] } },
  {
    name: 'transparent-aliases',
    mark: 'general',
    options: { effort: 'fast', sizes: [32, 48, 180, 32], bg: 'none', padding: 10, manifest: false },
  },
  {
    name: 'custom-manifest',
    mark: 'animated',
    options: {
      effort: 'fast',
      sizes: [180, 32],
      base: '/app/',
      manifest: { name: 'My app', theme_color: '#123456' },
      vars: { hub: '#ee3344' },
      animation: false,
      padding: 12,
    },
  },
];
