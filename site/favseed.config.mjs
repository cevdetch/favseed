import { defineConfig } from '../bin/favseed.mjs';

// pnpm's icons command runs here. Source and metadata live outside the generated set.
export default defineConfig({
  input: 'src/icon.svg',
  out: 'public',
  bg: '#25170d', // Keep the existing Apple icon's ground for every padded PNG.
  quality: 80,
  sizes: [192, 512],
  padding: 'auto',
  animation: true,
  mode: 'release',
  zopfli: false,
  base: '/',
  manifest: {
    name: 'favseed',
    short_name: 'favseed',
    description: 'One SVG in, an optimised favicon set out.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f6f8',
    theme_color: '#a6560a',
  },
});
