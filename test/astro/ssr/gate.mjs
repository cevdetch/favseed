// An explicit release request controls the body; no timing assumption about SSR speed.
let release;
export const pending = new Promise((resolve) => { release = resolve; });
export { release };
