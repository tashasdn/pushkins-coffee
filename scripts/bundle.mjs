import { mkdir, readFile, writeFile } from "node:fs/promises";
const functions = new URL("../supabase/functions/", import.meta.url);
const out = new URL("../.local/dashboard/", import.meta.url);
await mkdir(out, { recursive: true, mode: 0o700 });
const shared = (await readFile(new URL("_shared/core.js", functions), "utf8")).replace(/^export /gm, "");
for (const slug of ["create-application","telegram-hook","setup-telegram"]) {
  const entry = await readFile(new URL(`${slug}/index.ts`, functions), "utf8");
  const runtime = entry.replace(/^import .*\n/m, "").trim();
  await writeFile(new URL(`${slug}.ts`, out), `${shared}\n${runtime}\n`);
}
console.log("Готово: .local/dashboard");
