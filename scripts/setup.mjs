const [action, project] = process.argv.slice(2);
if (!["register","status","test"].includes(action) || !/^[a-z0-9]{20}$/.test(project || "")) {
  console.error("node scripts/setup.mjs <register|status|test> <project-ref>");
  process.exit(2);
}
try {
  process.loadEnvFile(new URL("../.local/secrets.env",import.meta.url));
  const secret = process.env.SETUP_SECRET;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error();
  const res = await fetch(`https://${project}.supabase.co/functions/v1/setup-telegram`, {
    method:"POST", headers: { "Content-Type":"application/json", "X-Setup-Secret":secret },
    body:JSON.stringify({action}), redirect:"error", signal:AbortSignal.timeout(30000)
  });
  const data = await res.json();
  console.log(JSON.stringify({ http:res.status, ...Object.fromEntries(
    ["ok","matches","pending","allowedUpdates","lastErrorAt","privateChat","error"].filter(k => Object.hasOwn(data,k)).map(k=>[k,data[k]])
  ) }));
  if (!res.ok) process.exitCode = 1;
} catch { console.error("Не удалось обратиться к функции настройки Supabase."); process.exitCode = 1; }
