import { defineConfig } from "vite";

// Data artifacts live in ../data/dist and are exposed at /data via a symlink
// in public/ (see app/public/data -> ../../data/dist). server.fs.allow lets
// Vite read through that symlink during dev.
// BASE_PATH is set by the GitHub Pages workflow (e.g. "/map-game/").
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  server: { fs: { allow: [".."] } },
});
