import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createTelegram } from "../supabase/functions/_shared/core.js";

const file = new URL("../.local/secrets.env", import.meta.url);
process.loadEnvFile(file);
const telegram = createTelegram(key => process.env[key]);

async function verify() {
  const webhook = await telegram("getWebhookInfo");
  if (!webhook.ok) throw new Error("Telegram API недоступен. Используйте /id в своём боте после регистрации webhook из Supabase.");
  if (webhook.result.url) throw new Error("Webhook уже подключён. Отправьте /id своему боту и проверьте ID в личном чате.");
  const bot = await telegram("getMe");
  if (!bot.ok || bot.result.is_bot !== true) throw new Error("Не удалось проверить имя бота.");
  const challenge = randomBytes(18).toString("base64url");
  const since = Math.floor(Date.now() / 1000);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(`В личном чате https://t.me/${bot.result.username} отправьте /start, затем сообщение \n${challenge}\nи нажмите Enter здесь. `);
  } finally { rl.close(); }
  const current = await telegram("getWebhookInfo");
  if (!current.ok || current.result.url) throw new Error("Состояние webhook изменилось. Используйте /id.");
  const updates = await telegram("getUpdates", { limit: 100, timeout: 0, allowed_updates: ["message","callback_query"] });
  const messages = updates.ok ? updates.result.map(item => item.message) : [];
  const matches = messages.filter(m => m?.text === challenge && m.date >= since && m.chat?.type === "private"
    && m.from?.is_bot === false && m.from.id === m.chat.id && Number.isSafeInteger(m.chat.id) && m.chat.id > 0);
  if (matches.length !== 1) throw new Error("Одноразовый код не подтверждён. Можно использовать /id после подключения webhook.");
  console.log(`BOT_USERNAME=${bot.result.username}\nADMIN_CHAT_ID=${matches[0].chat.id}`);
}
try { await verify(); } catch (error) { console.error(error.message); process.exitCode = 1; }
