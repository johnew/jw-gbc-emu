import { defineConfig } from "vite";

// Project Pages need "/<repo>/"; local/preview can use "/".
// Set BASE_PATH in CI (see .github/workflows/pages.yml).
export default defineConfig({
  base: process.env.BASE_PATH || "/",
});
