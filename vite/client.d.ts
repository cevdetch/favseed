// The virtual module the Vite plugin serves. It is an ambient declaration, so it has to be
// opted into, as Vite's own `vite/client` is: add "favseed/vite/client" to compilerOptions.types,
// or put `/// <reference types="favseed/vite/client" />` in a .d.ts file of the app.
declare module 'virtual:favseed' {
  /** The set's <link> tags, with `base` applied. */
  export const links: string;
  /** Every generated file: its name, the URL it is served at, and its MIME type. */
  export const files: { name: string; href: string; type: string }[];
}
