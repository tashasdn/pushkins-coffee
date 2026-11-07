(() => {
  const form = document.querySelector("#application");
  const button = form.querySelector("button");
  const status = document.querySelector("#status");
  const fields = { name: [1, 80], subject: [1, 120], description: [5, 2000] };
  const { endpoint, botUsername } = window.REQUESTS_CONFIG || {};
  const enabled = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/create-application$/.test(endpoint)
    && /^[A-Za-z0-9_]{5,32}$/.test(botUsername) && typeof crypto.randomUUID === "function";
  let attempt;
  let busy = false;

  function validate() {
    for (const [name, [min, max]] of Object.entries(fields)) {
      const input = form.elements.namedItem(name);
      const length = Array.from(input.value.trim()).length;
      document.querySelector(`#${name}-count`).textContent = `${length} / ${max}`;
      input.setCustomValidity(length < min || length > max ? `Введите от ${min} до ${max} символов.` : "");
    }
  }

  form.addEventListener("input", validate);
  validate();
  if (!enabled) return;
  button.disabled = false;
  status.textContent = "";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(form));
    for (const name of Object.keys(fields)) payload[name] = payload[name].trim();
    const fingerprint = JSON.stringify(payload);
    if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, idempotencyKey: crypto.randomUUID() };
    busy = true;
    button.disabled = true;
    status.className = "";
    status.textContent = "Сохраняем черновик…";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey: attempt.idempotencyKey }),
        signal: AbortSignal.timeout(15000),
        redirect: "error"
      });
      if (!res.ok) {
        if (res.status === 410) attempt = undefined;
        throw new Error(({400:"Проверьте поля формы.",409:"Поля не совпадают с предыдущей попыткой.",410:"Срок ссылки истёк. Нажмите кнопку ещё раз, чтобы создать новый черновик.",429:"Достигнут лимит обращений. Попробуйте позже.",503:"Приём обращений временно недоступен."})[res.status] || "Не удалось сохранить черновик. Попробуйте ещё раз.");
      }
      const { telegramUrl, expiresAt } = await res.json();
      const url = new URL(telegramUrl);
      if (url.origin !== "https://t.me" || url.pathname !== `/${botUsername}` || url.hash || url.username || url.password
          || !/^\?start=[A-Za-z0-9_-]{43}$/.test(url.search) || !Number.isFinite(Date.parse(expiresAt))) {
        throw new Error("Не удалось проверить ссылку на бота. Попробуйте ещё раз.");
      }
      document.querySelector("#telegram-link").href = url.href;
      const time = new Date(expiresAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
      document.querySelector("#expiry").textContent = `Ссылка действует до ${time} по вашему времени (30 минут с создания черновика). Не пересылайте её.`;
      status.textContent = "";
      document.querySelector("#form-screen").hidden = true;
      document.querySelector("#confirmation").hidden = false;
      document.querySelector("#confirm-title").focus();
    } catch (error) {
      status.className = "error";
      status.textContent = error instanceof TypeError || error.name === "TimeoutError" || error instanceof SyntaxError
        ? "Не удалось связаться с сервисом. Проверьте интернет и попробуйте ещё раз."
        : error.message;
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  document.querySelector(".back").addEventListener("click", () => {
    document.querySelector("#confirmation").hidden = true;
    document.querySelector("#form-screen").hidden = false;
    form.elements.namedItem("name").focus();
  });
})();
