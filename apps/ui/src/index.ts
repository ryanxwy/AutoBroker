/**
 * @autobroker/ui — Layer 5 React/Vite dashboard SPA.
 *
 * The runnable surface is the Vite entry (index.html → src/main.tsx → <App/>);
 * the desktop shell loads that built bundle. Tests import the framework-thin
 * pieces by relative path, so this package entry only needs to name the root
 * <App/> (a comment-only file would break isolatedModules, and package.json
 * main/types point at the emitted dist/index.js).
 */

export { App } from "./App.js";
