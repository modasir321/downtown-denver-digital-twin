import { cpSync, mkdirSync, existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "cesium", "Build", "Cesium");
const dest = join(root, "public", "cesium");

if (!existsSync(src)) {
  console.warn("Cesium build not found; skip copy");
  process.exit(0);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

for (const folder of ["Workers", "ThirdParty", "Assets", "Widgets"]) {
  cpSync(join(src, folder), join(dest, folder), { recursive: true });
}
cpSync(join(src, "Cesium.js"), join(dest, "Cesium.js"));
console.log("Copied Cesium assets → public/cesium");
