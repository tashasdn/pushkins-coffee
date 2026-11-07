const encoder = new TextEncoder();
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TOKEN = /^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{25,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const POSITIVE = /^[1-9][0-9]{0,17}$/;
const FIELD_LENGTHS = { name: [1, 80], subject: [1, 120], description: [5, 2000] };
const ALLOWED_UPDATES = ["message", "callback_query"];

class RequestError extends Error {
  constructor(status) { super("invalid_request"); this.status = status; }
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readJson(request, limit) {
  if (Number(request.headers.get("content-length")) > limit) throw new RequestError(413);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) {
    throw new RequestError(400);
  }
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (length + value.length > limit) {
      await reader.cancel();
      throw new RequestError(413);
    }
    bytes.set(value, length);
    length += value.length;
  }
  try {
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new RequestError(400);
  }
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url;
  } catch { /* Missing or invalid URL. */ }
  return null;
}

export function selectDatabaseKey(env) {
  if (env("SERVER_DB_KEY")) return env("SERVER_DB_KEY");
  const raw = env("SUPABASE_SECRET_KEYS");
  if (raw?.startsWith("sb_secret_")) return raw;
  try {
    const keys = JSON.parse(raw);
    if (keys && typeof keys === "object" && !Array.isArray(keys)) {
      if (typeof keys.default === "string" && keys.default) return keys.default;
      const first = Object.values(keys).find(key => typeof key === "string" && key);
      if (first) return first;
    }
  } catch { /* Legacy fallback. */ }
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

export function createRpc(env, transport = fetch) {
  const root = httpsUrl(env("SUPABASE_URL"));
  const key = selectDatabaseKey(env);
  if (!root || !key) throw new RequestError(503);
  return async (method, args) => {
    const headers = { "Content-Type": "application/json", apikey: key };
    if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
    const response = await transport(new URL(`/rest/v1/rpc/${method}`, root), {
      method: "POST", headers, body: JSON.stringify(args), redirect: "error", signal: AbortSignal.timeout(6500)
    });
    if (!response.ok) throw new Error("database_rpc_failed");
    return response.json();
  };
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function hashCode(code) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code))));
}

function urlSafe(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function authorized(received, expected) {
  if (!SECRET.test(expected) || !received || received.length > 256) return false;
  // Verify a fixed-length authenticator without a character-by-character early exit.
  const key = await crypto.subtle.importKey("raw", encoder.encode(expected), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, await hmac(received, "requests-app-header"), encoder.encode("requests-app-header"));
}

function owner(env) {
  const id = Number(env("ADMIN_CHAT_ID"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function clientAddress(request) {
  // Supabase hosted ingress provides this Cloudflare header. Missing/invalid values share one bucket.
  const ip = request.headers.get("cf-connecting-ip")?.trim().toLowerCase();
  return ip && ip.length <= 45 && /^[0-9a-f:.]+$/.test(ip) ? ip : "unknown";
}

function cleanText(value, min, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < min || length > max || /[\u0000\uD800-\uDFFF]/u.test(trimmed)) return null;
  return trimmed;
}

export function applicationHandler(env, rpc = (...args) => createRpc(env)(...args)) {
  return async request => {
    const origin = httpsUrl(env("SITE_URL"))?.origin;
    const supplied = request.headers.get("origin");
    const headers = { Vary: "Origin", ...(origin && origin === supplied ? { "Access-Control-Allow-Origin": origin } : {}) };
    if (supplied && origin !== supplied) return json({ error: "origin" }, 403, headers);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: origin === supplied ? 204 : 403, headers: {
        ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"
      } });
    }
    if (request.method !== "POST") return json({ error: "method" }, 405, headers);
    const botUsername = env("BOT_USERNAME");
    const secret = env("FORM_SECRET");
    if (!origin || !owner(env) || !USERNAME.test(botUsername) || !TOKEN.test(env("BOT_TOKEN"))
      || !SECRET.test(secret) || !SECRET.test(env("TG_WEBHOOK_SECRET"))) {
      return json({ error: "unavailable" }, 503, headers);
    }
    try {
      const payload = await readJson(request, 32768);
      const id = typeof payload.idempotencyKey === "string" && payload.idempotencyKey.toLowerCase();
      if (!UUID.test(id) || payload.website !== "") throw new RequestError(400);
      const fields = {};
      for (const [field, [min, max]] of Object.entries(FIELD_LENGTHS)) {
        const value = cleanText(payload[field], min, max);
        if (value === null) throw new RequestError(400);
        fields[`p_${field}`] = value;
      }
      const code = urlSafe(await hmac(secret, id));
      const result = await rpc("nr_create_draft", {
        p_key: id, ...fields, p_code_hash: await hashCode(code),
        p_ip_hash: hex(await hmac(secret, `ip:${clientAddress(request)}`))
      });
      if (result?.result === "ok") {
        return json({ telegramUrl: `https://t.me/${botUsername}?start=${code}`, expiresAt: result.expiresAt }, 200, headers);
      }
      return json({ error: result?.result }, { conflict: 409, expired: 410, limited: 429, invalid: 400 }[result?.result] || 503, headers);
    } catch (error) {
      return json({ error: "form" }, error instanceof RequestError ? error.status : 503, headers);
    }
  };
}

export function createTelegram(env, transport = fetch) {
  const token = env("BOT_TOKEN");
  return async (method, payload = {}) => {
    if (!TOKEN.test(token)) return { ok: false, error: "telegram_config" };
    try {
      const response = await transport(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(6500)
      });
      const data = await response.json();
      if (response.ok && data.ok === true) return { ok: true, result: data.result };
      const code = Number.isInteger(data.error_code) ? data.error_code : response.status;
      return { ok: false, error: `telegram_${code}`, delay: Number.isInteger(data.parameters?.retry_after) ? data.parameters.retry_after : 0 };
    } catch {
      return { ok: false, error: "telegram_transport" };
    }
  };
}

function parseCallback(data) {
  if (typeof data !== "string" || data.length > 64) return { action: "unknown" };
  const [key, ref, page, extra] = data.split(":");
  const validPage = value => /^(0|[1-9][0-9]{0,5})$/.test(value);
  const action = { c: "card", p: "prompt", w: "work", d: "done", r: "retry" }[key];
  if (action && POSITIVE.test(ref) && page === undefined) return { action, ref };
  if (key === "l" && /^[mnwa]$/.test(ref) && validPage(page) && extra === undefined) return { action: "list", ref, page: Number(page) };
  if (key === "h" && POSITIVE.test(ref) && validPage(page) && extra === undefined) return { action: "history", ref, page: Number(page) };
  if (key === "e" && validPage(ref) && page === undefined) return { action: "retry_menu", page: Number(ref) };
  return { action: "unknown" };
}

async function normalize(update, env) {
  const cb = update.callback_query;
  const message = cb ? cb.message : update.message;
  const from = cb ? cb.from : message?.from;
  const chat = message?.chat;
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || chat?.type !== "private"
    || !Number.isSafeInteger(chat.id) || chat.id <= 0 || from?.is_bot !== false || from.id !== chat.id) return null;
  const base = { id: update.update_id, chat: chat.id, from: from.id, private: true, bot: false };
  if (cb) return { ...base, ...parseCallback(cb.data) };

  const reply = message.reply_to_message;
  const botId = Number(env("BOT_TOKEN")?.split(":")[0]);
  if (reply?.from?.is_bot === true && reply.from.id === botId
    && Number.isSafeInteger(reply.message_id) && reply.message_id > 0) {
    const nonce = /\nКод подсказки: ([0-9a-f-]{36})$/.exec(reply.text)?.[1];
    return { ...base, action: "reply", text: cleanText(message.text, 1, 2000), replyTo: reply.message_id, nonce: UUID.test(nonce) ? nonce : null };
  }
  const content = cleanText(message.text, 1, 2000);
  const match = /^\/(start|id|my|requests|retry)(?:@([A-Za-z0-9_]+))?(?: ([A-Za-z0-9_-]+))?$/.exec(content || "");
  if (!match || (match[2] && match[2].toLowerCase() !== env("BOT_USERNAME")?.toLowerCase())) return { ...base, action: "unknown" };
  switch (match[1]) {
    case "start":
      if (match[3] && !CODE.test(match[3])) return { ...base, action: "start", ref: "invalid" };
      return { ...base, action: "start", ref: match[3] ? await hashCode(match[3]) : null };
    case "id": return { ...base, action: "id" };
    case "my": return { ...base, action: "list", ref: "m" };
    case "requests": return { ...base, action: "list", ref: "n" };
    case "retry": return { ...base, action: "retry_menu" };
  }
}

async function deliver(rpc, telegram, update) {
  const deadline = Date.now() + 20000;
  for (let count = 0; count < 8 && Date.now() < deadline; count++) {
    const job = await rpc("nr_claim_outbox", { p_update: update }) || await rpc("nr_claim_outbox", { p_update: null });
    if (!job) break;
    const sent = await telegram("sendMessage", { ...job.payload, chat_id: job.chat_id, link_preview_options: { is_disabled: true } });
    const claim = { p_id: job.id, p_lease: job.lease_token };
    const messageId = sent.result?.message_id;
    if (sent.ok && Number.isSafeInteger(messageId) && messageId > 0) {
      if (!await rpc("nr_delivered", { ...claim, p_message: messageId })) throw new Error("lost_lease");
    } else {
      if (!await rpc("nr_failed", { ...claim, p_error: sent.error || "telegram_response", p_delay: sent.delay || 0 })) {
        throw new Error("lost_lease");
      }
    }
  }
  return await rpc("nr_pending_count", { p_update: update });
}

export function hookHandler(env, rpc = (...args) => createRpc(env)(...args), telegram = createTelegram(env)) {
  return async request => {
    if (!await authorized(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env("TG_WEBHOOK_SECRET"))) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);
    try {
      const update = await readJson(request, 524288);
      const event = await normalize(update, env);
      const callbackId = update.callback_query?.id;
      if (typeof callbackId === "string" && /^[0-9]{1,64}$/.test(callbackId)) {
        await telegram("answerCallbackQuery", { callback_query_id: callbackId });
      }
      if (!event) return json({ ok: true });
      await rpc("nr_handle_update", { p_event: event, p_admin: owner(env) });
      if (await deliver(rpc, telegram, event.id)) return json({ error: "delivery_pending" }, 503);
      return json({ ok: true });
    } catch (error) {
      return json({ error: "update" }, error instanceof RequestError ? error.status : 503);
    }
  };
}

export function setupHandler(env, telegram = createTelegram(env)) {
  return async request => {
    if (!await authorized(request.headers.get("X-Setup-Secret"), env("SETUP_SECRET"))) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);
    try {
      const { action } = await readJson(request, 1024);
      const root = httpsUrl(env("SUPABASE_URL"));
      const webhookSecret = env("TG_WEBHOOK_SECRET");
      const username = env("BOT_USERNAME");
      if (!root || !SECRET.test(webhookSecret) || !USERNAME.test(username) || !TOKEN.test(env("BOT_TOKEN"))) {
        throw new RequestError(503);
      }
      const webhook = new URL("/functions/v1/telegram-hook", root).href;
      const me = await telegram("getMe");
      if (!me.ok || me.result?.username !== username || me.result?.is_bot !== true) return json({ error: "bot_identity" }, 503);
      if (action === "test") {
        const chat = owner(env);
        if (!chat) throw new RequestError(503);
        const sent = await telegram("sendMessage", { chat_id: chat, text: "PUSHKINS COFFEE. Проверка подключения Telegram. Это служебное сообщение." });
        return sent.ok && sent.result?.chat?.type === "private" && sent.result.chat.id === chat
          ? json({ ok: true, privateChat: true })
          : json({ error: sent.error || "wrong_chat" }, 503);
      }
      if (action !== "register" && action !== "status") throw new RequestError(400);
      const info = await telegram("getWebhookInfo");
      if (!info.ok) return json({ error: info.error }, 503);
      if (action === "status") return json({
        matches: info.result.url === webhook, pending: info.result.pending_update_count,
        allowedUpdates: info.result.allowed_updates, lastErrorAt: info.result.last_error_date ?? null
      });
      if (info.result.url && info.result.url !== webhook) return json({ error: "other_webhook" }, 409);
      const set = await telegram("setWebhook", { url: webhook, secret_token: webhookSecret,
        allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false });
      return set.ok && set.result === true ? json({ ok: true }) : json({ error: set.error || "telegram_response" }, 503);
    } catch (error) {
      return json({ error: "setup" }, error instanceof RequestError ? error.status : 503);
    }
  };
}
