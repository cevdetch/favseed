export const cases = [
  { name: 'small-mark/placement', mark: 'small-mark', options: {} },
  ...['aspect-wide', 'aspect-tall', 'aspect-offset', 'aspect-percent']
    .map((mark) => ({ name: `${mark}/proportions`, mark, options: {} })),
  { name: 'aspect-percent/transparent', mark: 'aspect-percent', options: { bg: 'none', padding: 0, sizes: [32, 128] } },
  ...['grid-1', 'grid-16', 'grid-24', 'grid-tiny', 'grid-fallback'].map((mark) => ({ name: `${mark}/precision`, mark, options: {} })),
  { name: 'gradient/quality100', mark: 'gradient', options: { quality: 100 } },
  { name: 'gradient/quality80', mark: 'gradient', options: { quality: 80 } },
  { name: 'gradient/quality60-zopfli', mark: 'gradient', options: { quality: 60, zopfli: true, mode: 'fast', sizes: [32] } },
  ...['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark']
    .map((mark) => ({ name: `${mark}/fast`, mark, options: { mode: 'fast' } })),
  ...['tiles', 'gradient'].map((mark) => ({ name: `${mark}/release`, mark, options: { mode: 'release', zopfli: true } })),
  { name: 'general/zopfli-fast', mark: 'general', options: { mode: 'fast', zopfli: true } },
  { name: 'transparent-aliases', mark: 'general', options: { mode: 'fast', sizes: [32, 48, 180, 32], bg: 'none', padding: 10, manifest: false } },
  { name: 'custom-manifest', mark: 'animated', options: { mode: 'fast', sizes: [180, 32], base: '/app/',
    manifest: { name: 'My app', theme_color: '#123456' }, vars: { hub: '#ee3344' }, animation: false, padding: 12 } },
];
