import { release } from '../gate.mjs';
export const GET = () => {
  release();
  return new Response('released');
};
