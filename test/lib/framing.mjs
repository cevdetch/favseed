// Literal square goldens, derived by hand without the production framing code.
const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
  + '<circle cx="64" cy="64" r="16" fill="#175d8d"/>'
  + '<rect x="16" y="48" width="16" height="32" fill="#e9b44c"/></svg>';
export const framingCases = [
  { mark: 'aspect-wide', golden: wide },
  { mark: 'aspect-tall', golden: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<circle cx="64" cy="64" r="16" fill="#175d8d"/>'
    + '<rect x="48" y="16" width="32" height="16" fill="#e9b44c"/></svg>' },
  { mark: 'aspect-offset', golden: wide },
  { mark: 'aspect-percent', golden: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect x="32" y="48" width="64" height="32" fill="#175d8d"/></svg>' },
];
