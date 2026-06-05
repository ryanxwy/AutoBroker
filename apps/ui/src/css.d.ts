/** Ambient declaration so `tsc -b` accepts the CSS side-effect import in main.tsx
 *  (Vite handles the actual bundling; the type checker just needs the module to
 *  exist). */
declare module "*.css";
