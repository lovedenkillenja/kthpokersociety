// Copies pure engine modules from `game/engine/` into `supabase/functions/_shared/engine/`
// so Supabase Edge Functions (Deno) can bundle them without reaching outside `supabase/functions/`.
// Verified by `game/tests/engine-sync.test.js` during `node --test`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../engine");
const destDir = path.resolve(__dirname, "../../supabase/functions/_shared/engine");

fs.mkdirSync(destDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
for (const file of files) {
  const content = fs.readFileSync(path.join(srcDir, file), "utf8");
  fs.writeFileSync(path.join(destDir, file), content, "utf8");
}

console.log(`Synced ${files.length} engine files to supabase/functions/_shared/engine/`);
