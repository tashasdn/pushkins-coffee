import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applicationHandler, hookHandler, setupHandler, createRpc, selectDatabaseKey } from "../supabase/functions/_shared/core.js";

const db = new PGlite();
const settings = {
  BOT_TOKEN: "8000000:" + "Z".repeat(35), BOT_USERNAME: "FixtureCoffeeBot", SITE_URL: "https://example.test/pushkins-coffee/",
  ADMIN_CHAT_ID: "900", TG_WEBHOOK_SECRET: "a".repeat(48), FORM_SECRET: "b".repeat(48), SETUP_SECRET: "c".repeat(48),
  SUPABASE_URL: "https://fixture.supabase.co"
};
const env = key => settings[key];
const signatures = {
  nr_create_draft: ["p_key","p_name","p_subject","p_description","p_code_hash","p_ip_hash"],
  nr_handle_update: ["p_event","p_admin"], nr_claim_outbox: ["p_update"], nr_pending_count: ["p_update"],
  nr_delivered: ["p_id","p_lease","p_message"], nr_failed: ["p_id","p_lease","p_error","p_delay"]
};
async function rpc(method, params) {
  const values = signatures[method].map(key => params[key]);
  return (await db.query(`select public.${method}(${values.map((_, i) => `$${i + 1}`).join(", ")}) as result`, values)).rows[0].result;
}
before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
});
after(async () => db.close());

const form = applicationHandler(env, rpc);
const origin = "https://example.test";
const headers = { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "192.0.2.1" };
const input = (subject = "Вопрос по меню") => ({
  idempotencyKey: crypto.randomUUID(), name: "Проверка", subject, description: "Подробности вопроса", website: ""
});
const post = (body, extra = {}) => new Request(origin, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const draft = async subject => {
  const res = await form(post(input(subject)));
  assert.equal(res.status, 200);
  return new URL((await res.json()).telegramUrl).searchParams.get("start");
};

let serial = 0;
let blocked;
let intercept;
const sent = [];
async function telegram(method, payload) {
  if (method !== "sendMessage") return { ok: true };
  assert.equal(payload.parse_mode, undefined);
  if (payload.chat_id === blocked && payload.text.startsWith("Ответ кофейни")) return { ok: false, error: "telegram_403" };
  const result = { message_id: ++serial, text: payload.text, from: { id: 8000000, is_bot: true } };
  sent.push({ ...payload, result });
  if (payload.reply_markup?.force_reply && intercept) await intercept(result);
  return { ok: true, result };
}
const hook = hookHandler(env, rpc, telegram);
let nextUpdate = 100;
const sender = id => ({ id, is_bot: false });
const msg = (id, text, reply) => ({
  update_id: nextUpdate++, message: { chat: { id, type: "private" }, from: sender(id), text, reply_to_message: reply }
});
const cb = (id, data) => ({
  update_id: nextUpdate++, callback_query: { id: "712331", from: sender(id), data, message: { chat: { id, type: "private" } } }
});
const fire = (event, secret = settings.TG_WEBHOOK_SECRET) => hook(post(event, { "X-Telegram-Bot-Api-Secret-Token": secret }));
const accept = async event => assert.equal((await fire(event)).status, 200);
const last = id => sent.findLast(x => x.chat_id === String(id));
const rows = async (sql, args) => (await db.query(sql, args)).rows;

test("Права RPC, RLS и закрытая схема", async () => {
  const tables = await rows("select relrowsecurity from pg_class where relnamespace='requests_app'::regnamespace and relkind='r'");
  assert.equal(tables.length, 5);
  assert.ok(tables.every(row => row.relrowsecurity));
  for (const role of ["anon","authenticated"]) {
    assert.equal((await rows("select has_schema_privilege($1, 'requests_app', 'USAGE') as allowed", [role]))[0].allowed,false);
    assert.equal((await rows("select has_function_privilege($1, 'public.nr_handle_update(jsonb,bigint)', 'EXECUTE') as allowed", [role]))[0].allowed,false);
  }
  assert.equal((await rows("select has_function_privilege('service_role', 'public.nr_handle_update(jsonb,bigint)', 'EXECUTE') as allowed"))[0].allowed,true);
});

test("Форма, повторы, CORS, размер, отключение без владельца и просроченная ссылка", async () => {
  const payload = input();
  const res = await form(post(payload));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
  const first = await res.json();
  assert.deepEqual(Object.keys(first).sort(), ["expiresAt","telegramUrl"]);
  assert.match(first.telegramUrl, /^https:\/\/t\.me\/FixtureCoffeeBot\?start=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await (await form(post(payload))).json(),first);
  assert.equal((await form(post({ ...payload, name: "Другое имя" }))).status,409);
  assert.equal((await form(post({ ...payload, website: "bot" }))).status,400);
  assert.equal((await form(post({ ...payload, description: "кот" }))).status,400);
  assert.equal((await form(post({ ...payload, description: "x".repeat(40000) }))).status,413);
  assert.equal((await form(post(payload, { Origin: origin + "/pushkins-coffee/" }))).status,403);
  const options = await form(new Request(origin, { method:"OPTIONS", headers }));
  assert.equal(options.status,204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"),origin);
  assert.equal((await applicationHandler(key => key === "ADMIN_CHAT_ID" ? "" : env(key),rpc)(post(payload))).status,503);
  await db.query("update requests_app.tickets set expires_at=clock_timestamp()-interval '1 second' where request_key=$1",[payload.idempotencyKey]);
  await accept(msg(101,"/start " + new URL(first.telegramUrl).searchParams.get("start")));
  assert.match(last(101).text,/срок истёк/);
  assert.equal((await form(post(payload))).status,410);
});

test("Два клиента, два обращения одного клиента, статусы, история и ForceReply", async () => {
  const a = await draft("Тема А");
  const b = await draft("Тема Б");
  const c = await draft("Тема В");
  await accept(msg(900,"/requests"));
  assert.match(last(900).text,/обращений нет/);
  const startA = msg(101,"/start " + a);
  await accept(startA);
  const afterStart = sent.length;
  await accept(startA);
  assert.equal(sent.length, afterStart);
  await accept(msg(101,"/start " + a));
  assert.match(last(101).text,/уже подтверждено/);
  await accept(msg(102,"/start " + a));
  assert.match(last(102).text,/срок истёк/);
  await accept(msg(101,"/start " + b));
  await accept(msg(102,"/start " + c));
  const [t1,t2,t3] = await rows("select number from requests_app.tickets where status='new' order by number");
  await accept(msg(101,"/my"));
  assert.match(last(101).text,/Тема А/);
  assert.match(last(101).text,/Тема Б/);
  assert.doesNotMatch(last(101).text,/Тема В/);
  await accept(msg(101,"/requests"));
  assert.match(last(101).text,/недоступна/);
  await accept(cb(101,`h:${t3.number}:0`));
  assert.match(last(101).text,/недоступно/);
  await accept(cb(101,`d:${t1.number}`));
  assert.match(last(101).text,/недоступно/);
  await accept(cb(900,`p:${t1.number}`));
  const prompt1 = last(900).result;
  await accept(cb(900,`p:${t2.number}`));
  const prompt2 = last(900).result;
  await accept(msg(900,"Ответ по Б",prompt2));
  assert.match(last(101).text,new RegExp(`№${t2.number}`));
  await accept(msg(900,"Ответ по А",prompt1));
  assert.match(last(101).text,new RegExp(`№${t1.number}`));
  assert.match(last(900).text,/доставлено/);
  await accept(cb(102,`p:${t3.number}`));
  await accept(msg(102,"Уточнение второго клиента",last(102).result));
  assert.match(last(900).text,/Уточнение второго клиента/);
  await accept(cb(101,`h:${t1.number}:1`));
  assert.match(last(101).text,/Ответ по А/);
  await accept(cb(900,`w:${t1.number}`));
  assert.match(last(101).text,/В работе/);
  await accept(cb(900,`d:${t1.number}`));
  assert.match(last(101).text,/Завершена/);
  assert.equal((await rows("select count(*)::int as count from requests_app.messages"))[0].count,3);
});

test("Проверка секрета, отправителя и частоты обновлений", async () => {
  const beforeCount = sent.length;
  assert.equal((await fire(msg(801,"/id"), "wrong")).status,401);
  assert.equal((await hook(post(msg(801,"/id")))).status,401);
  const forged = msg(801,"/requests");
  forged.message.from.id = 900;
  await accept(forged);
  assert.equal(sent.length,beforeCount);
  for (let i=0; i<31; i++) await accept(msg(801,"/id"));
  assert.equal(sent.filter(x => x.chat_id==="801").length,30);
});

test("Быстрый ответ повторяется после записи подсказки", async () => {
  const [{number}] = await rows("select number from requests_app.tickets where chat_id=101 order by number limit 1");
  let reply;
  intercept = async prompt => {
    reply = msg(900,"Очень быстрый ответ",prompt);
    assert.equal((await fire(reply)).status,503);
    assert.equal((await rows("select id from requests_app.updates where id=$1",[reply.update_id])).length,0);
  };
  try { await accept(cb(900,`p:${number}`)); } finally { intercept = undefined; }
  await accept(reply);
  assert.match(last(101).text,/Очень быстрый ответ/);
});

test("Ошибка доставки и ручной повтор", async () => {
  const [{number}] = await rows("select number from requests_app.tickets where chat_id=101 order by number limit 1");
  await accept(cb(900,`p:${number}`));
  blocked = "101";
  const event = msg(900,"Ответ при блокировке",last(900).result);
  await accept(event);
  assert.match(last(900).text,/сохранено/);
  const [job] = await rows("select id, state, error_code from requests_app.outbox where effect_key=$1",[`${event.update_id}:message`]);
  assert.equal(job.state,"failed");
  assert.equal(job.error_code,"telegram_403");
  await accept(cb(102,`r:${job.id}`));
  assert.match(last(102).text,/недоступна/);
  blocked = undefined;
  await accept(msg(900,"/retry"));
  assert.match(last(900).text,/telegram_403/);
  await accept(cb(900,`r:${job.id}`));
  assert.match(last(101).text,/Ответ при блокировке/);
  assert.deepEqual((await rows("select state, attempts from requests_app.outbox where id=$1",[job.id]))[0],{state:"sent",attempts:2});
});

test("Восстановление аренды и отказ старому владельцу аренды", async () => {
  const id = nextUpdate++;
  await rpc("nr_handle_update", { p_event: { id, chat: 702, from: 702, private: true, bot: false, action: "id" }, p_admin: 900 });
  const first = await rpc("nr_claim_outbox",{p_update:id});
  assert.ok(first);
  assert.equal(await rpc("nr_claim_outbox",{p_update:id}),null);
  await db.query("update requests_app.outbox set leased_until=clock_timestamp()-interval '1 second' where id=$1",[first.id]);
  const second = await rpc("nr_claim_outbox",{p_update:id});
  assert.equal(second.id,first.id);
  assert.notEqual(second.lease_token,first.lease_token);
  assert.equal(await rpc("nr_delivered",{p_id:first.id,p_lease:first.lease_token,p_message:1234}),false);
  assert.equal(await rpc("nr_delivered",{p_id:second.id,p_lease:second.lease_token,p_message:1234}),true);
});

test("Десять форм на IP и пятьсот в сутки", async () => {
  const ip = { "cf-connecting-ip": "192.0.2.99" };
  for(let i=0;i<10;i++) assert.equal((await form(post(input(),ip))).status,200);
  assert.equal((await form(post(input(),ip))).status,429);
  await db.exec(`insert into requests_app.tickets(request_key,name,subject,description,code_hash,ip_hash)
    select gen_random_uuid(),'Тест','Тест','Проверка лимита',md5(i::text)||md5(i::text),'fixture'
    from generate_series(1, 500 - (select count(*)::int from requests_app.tickets)) i`);
  assert.equal((await form(post(input(),{"cf-connecting-ip":"192.0.2.88"}))).status,429);
});

test("Ключи Supabase и HTTP-заголовки RPC", async () => {
  for (const [extra,key,bearer] of [
    [{SUPABASE_SECRET_KEYS:'{"other":"sb_secret_first","default":"sb_secret_default"}'},"sb_secret_default",false],
    [{SUPABASE_SECRET_KEYS:'{"other":"sb_secret_first"}'},"sb_secret_first",false],
    [{SUPABASE_SECRET_KEYS:"{}" ,SUPABASE_SERVICE_ROLE_KEY:"legacy"},"legacy",true],
    [{SERVER_DB_KEY:"sb_secret_explicit",SUPABASE_SECRET_KEYS:"sb_secret_ignored"},"sb_secret_explicit",false]
  ]) {
    const config = name => extra[name] ?? env(name);
    assert.equal(selectDatabaseKey(config),key);
    const client = createRpc(config, async (_url, init) => {
      assert.equal(init.headers.apikey,key);
      assert.equal(init.headers.Authorization,bearer ? `Bearer ${key}` : undefined);
      return Response.json(true);
    });
    assert.equal(await client("nr_test", {}),true);
  }
});

test("Настройка webhook проверяет секрет и сохраняет накопленные обновления", async () => {
  const trace = [];
  const handler = setupHandler(env, async (method, args) => {
    trace.push({method,args});
    return {ok:true,result:({getMe:{username:settings.BOT_USERNAME,is_bot:true},getWebhookInfo:{url:""},setWebhook:true})[method]};
  });
  assert.equal((await handler(post({action:"register"}))).status,401);
  assert.equal(trace.length,0);
  assert.equal((await handler(post({action:"register"},{"X-Setup-Secret":settings.SETUP_SECRET}))).status,200);
  assert.equal(trace.at(-1).args.drop_pending_updates,false);
  assert.deepEqual(trace.at(-1).args.allowed_updates,["message","callback_query"]);
});
