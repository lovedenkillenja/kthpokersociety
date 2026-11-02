import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(__dirname, "../engine");
const sharedEngineDir = path.resolve(__dirname, "../../supabase/functions/_shared/engine");

test("supabase/functions/_shared/engine is byte-for-byte identical to game/engine", () => {
  const srcFiles = fs.readdirSync(engineDir).filter((f) => f.endsWith(".js")).sort();
  const destFiles = fs.readdirSync(sharedEngineDir).filter((f) => f.endsWith(".js")).sort();

  assert.deepEqual(
    destFiles,
    srcFiles,
    "Engine file list in supabase/functions/_shared/engine/ differs from game/engine/. Run `node game/scripts/sync-engine.js`."
  );

  for (const file of srcFiles) {
    const srcContent = fs.readFileSync(path.join(engineDir, file), "utf8");
    const destContent = fs.readFileSync(path.join(sharedEngineDir, file), "utf8");
    assert.equal(
      destContent,
      srcContent,
      `File ${file} in supabase/functions/_shared/engine/ differs from game/engine/${file}. Run \`node game/scripts/sync-engine.js\`.`
    );
  }
});
