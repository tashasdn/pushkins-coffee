import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const root = new URL("../", import.meta.url);
const path = name => fileURLToPath(new URL(name, root));
const files = ["index.html","styles.css","app.js","config.js","menu.jpg",".nojekyll"];
assert.deepEqual((await readdir(path("public/"))).sort(), files.sort());
const read = name => readFile(path(name),"utf8");
const content = await read("public/index.html");
for (const match of content.matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert.ok(match[1].startsWith("#") || match[1] === "./" ||
    (match[1].startsWith("./") && files.includes(match[1].slice(2))), "Публичный путь должен быть относительным");
}
const context = vm.runInNewContext(await read("public/config.js") + "\nwindow.REQUESTS_CONFIG", { window: {} }, { timeout: 1000 });
assert.deepEqual(Object.keys(context).sort(),["botUsername","endpoint"]);
assert.ok((context.endpoint === "" && context.botUsername === "") ||
  (/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/create-application$/.test(context.endpoint)
    && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(context.botUsername)));
const source = ["public/index.html","public/styles.css","public/app.js","public/config.js","supabase/functions/_shared/core.js"];
for (const name of ["create-application","telegram-hook","setup-telegram"]) source.push(`supabase/functions/${name}/index.ts`);
const git = spawnSync("git", ["ls-files","-z"], {cwd:path("./"),encoding:"utf8"});
const privatePath = /(^|\/)(\.local|\.env[^/]*|node_modules|\.temp|\.branches)(\/|$)/;
if (git.status === 0) {
  for (const name of git.stdout.split("\0").filter(Boolean)) {
    assert.ok(!privatePath.test(name), "Служебный файл отслеживается Git");
    if (!name.endsWith(".jpg")) source.push(name);
  }
}
for (const name of new Set(source)) {
  if (/\.(?:m?js|ts)$/.test(name)) {
    const result = spawnSync(process.execPath,["--check",path(name)],{stdio:"inherit"});
    assert.equal(result.status,0,`Синтаксис: ${name}`);
  }
  const content = await read(name);
  assert.ok(!/(?:\b[1-9][0-9]{5,15}:[A-Za-z0-9_-]{25,}\b|\bsb_secret_[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b)/.test(content), `Возможный секрет: ${name}`);
}
console.log("Синтаксис, относительные пути, конфигурация и проверка на секреты пройдены.");
