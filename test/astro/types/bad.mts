import { build, defineConfig } from 'favseed';
import favseedVite from 'favseed/vite';
import favseedAstro from 'favseed/astro';

defineConfig({ colours: 8 });
build({ sizes: [48] });
favseedVite({ out: 'dist' });
favseedVite({ colours: 8 });
favseedAstro({ out: 'public' });
favseedAstro({ base: '/other/' });
favseedAstro({ imput: 'logo.svg' });
favseedAstro({ head: 'maybe' });
favseedAstro({ quality: 'small' });
