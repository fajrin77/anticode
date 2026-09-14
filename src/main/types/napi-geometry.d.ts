/**
 * The geometry part of @napi-rs/canvas is plain JavaScript without its own
 * declarations. anticode only borrows its three DOM geometry classes as a
 * main-process polyfill for the PDF stack, so this minimal shape is all the
 * typing the import needs.
 */
declare module '@napi-rs/canvas/geometry.js' {
  export const DOMMatrix: unknown
  export const DOMPoint: unknown
  export const DOMRect: unknown
}
