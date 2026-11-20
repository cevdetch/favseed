import { defineConfig } from '../bin/favseed.mjs';

// pnpm's icons command runs here. Source and metadata live outside the generated set.
export default defineConfig({
  input: 'src/icon.svg',
  out: 'public',
  bg: '#25170d', // Keep the existing Apple icon's ground for every padded PNG.
  // A square mark at `auto` reaches the W3C safe circle (40% radius) with its corners, and an
  // Android home-screen shortcut shows only about 36%, so the corners were cut. 26 puts them at
  // 29.6%. Decision 32.
  padding: 26,
  manifest: {
    id: '/',
    name: 'favseed',
    short_name: 'favseed',
    description: 'favseed turns one SVG into an optimised favicon set.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f6f8',
    theme_color: '#a6560a',
  },
});
