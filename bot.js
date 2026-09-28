import { Bot, Keyboard } from "grammy";
import express from "express";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const bot = new Bot(process.env.TELEGRAM_TOKEN);

const users = new Map();    // phone -> { salt, hash }
const sessions = new Map(); // chatId -> { token, mode, step, phone, attempts }
const logins = new Map();   // token -> { verified, phone }

const menuKb = new Keyboard().text("📝 Регистрация").text("🔑 Вход").resized();
const contactKb = new Keyboard()
  .requestContact("📱 Поделиться номером")
  .row()
  .text("❌ Отмена")
  .resized();

const hashCode = (code, salt) => scryptSync(code, salt, 32);
const cleanPhone = (p) => p.replace(/\D/g, "");

function toMenu(ctx, text) {
  const s = sessions.get(ctx.chat.id);
  if (s) {
    s.mode = null;
    s.step = "menu";
    s.phone = null;
    s.attempts = 0;
  }
  return ctx.reply(text, { reply_markup: menuKb });
}

bot.command("start", (ctx) => {
  const token = ctx.match?.trim() || "test-" + ctx.chat.id;
  logins.set(token, { verified: false });
  sessions.set(ctx.chat.id, {
    token,
    mode: null,
    step: "menu",
    phone: null,
    attempts: 0,
  });
  return ctx.reply("Привет! Выбери действие:", { reply_markup: menuKb });
});

bot.on("message:contact", async (ctx) => {
  const s = sessions.get(ctx.chat.id);
  if (!s || s.step !== "await_phone") {
    return ctx.reply("Напиши /start, чтобы начать.");
  }
  const c = ctx.message.contact;
  if (c.user_id !== ctx.from.id) {
    return ctx.reply("Нужно отправить свой номер кнопкой «Поделиться номером».");
  }
  const phone = cleanPhone(c.phone_number);
  const exists = users.has(phone);

  if (s.mode === "register") {
    if (exists) return toMenu(ctx, "Этот аккаунт уже подключён. Нажми «Вход».");
    s.phone = phone;
    s.step = "await_new_code";
    return ctx.reply("Придумай код из 4–8 цифр. Он понадобится для входа:", {
      reply_markup: { remove_keyboard: true },
    });
  }

  if (!exists) {
    return toMenu(ctx, "Аккаунт не найден. Сначала нажми «Регистрация».");
  }
  s.phone = phone;
  s.step = "await_code";
  s.attempts = 0;
  return ctx.reply("Введи свой код:", {
    reply_markup: { remove_keyboard: true },
  });
});

bot.on("message:text", async (ctx) => {
  const s = sessions.get(ctx.chat.id);
  const text = ctx.message.text.trim();
  if (!s) return ctx.reply("Напиши /start, чтобы начать.");

  if (text === "❌ Отмена") return toMenu(ctx, "Отменено.");

  if (text === "📝 Регистрация" || text === "🔑 Вход") {
    s.mode = text === "📝 Регистрация" ? "register" : "login";
    s.step = "await_phone";
    return ctx.reply("Нажми кнопку и поделись номером:", {
      reply_markup: contactKb,
    });
  }

  if (s.step === "await_new_code") {
    ctx.deleteMessage().catch(() => {});
    if (!/^\d{4,8}$/.test(text)) {
      return ctx.reply("Код должен состоять из 4–8 цифр. Попробуй ещё раз:");
    }
    const salt = randomBytes(16);
    users.set(s.phone, { salt, hash: hashCode(text, salt) });
    return toMenu(ctx, "Регистрация завершена! Теперь нажми «Вход».");
  }

  if (s.step === "await_code") {
    ctx.deleteMessage().catch(() => {});
    const u = users.get(s.phone);
    const ok = u && timingSafeEqual(hashCode(text, u.salt), u.hash);
    if (ok) {
      const entry = logins.get(s.token);
      if (entry) {
        entry.verified = true;
        entry.phone = s.phone;
      }
      s.step = "menu";
      return ctx.reply("Готово! Вход подтверждён. Возвращайся в приложение.", {
        reply_markup: menuKb,
      });
    }
    s.attempts++;
    if (s.attempts >= 5) {
      return toMenu(ctx, "Слишком много попыток. Начни заново.");
    }
    return ctx.reply("Неверный код, попробуй ещё раз:");
  }

  return ctx.reply("Выбери действие кнопкой ниже:", { reply_markup: menuKb });
});

bot.start();

const app = express();
app.get("/new-token", (req, res) => {
  const token = Math.random().toString(36).slice(2) + Date.now();
  res.json({ token });
});
app.get("/status", (req, res) => {
  const entry = logins.get(req.query.token);
  if (!entry) return res.json({ verified: false });
  res.json({ verified: !!entry.verified, phone: entry.phone ?? null });
});
app.listen(process.env.PORT || 3000, () => console.log("HTTP запущен"));
