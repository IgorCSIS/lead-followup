import { defineConfig } from "vite";

/**
 * Vite config.
 *
 * `base` has to match the repo name for GitHub Pages. Deploying to
 * <user>.github.io/<repo> means every asset URL carries that prefix, and
 * getting it wrong produces a page that works locally and 404s in production.
 */
export default defineConfig({
  base: "/lead-followup/",
  build: {
    target: "es2022",
    // The whole app is a few KB of templates plus PapaParse. Inlining the
    // small assets keeps the request count down on a phone.
    assetsInlineLimit: 4096,
  },
});
