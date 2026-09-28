import { Bot, Keyboard } from "grammy";
import express from "express";

const bot = new Bot(process.env.TELEGRAM_TOKEN);

// token -> { chatId, verified, phone }
const logins = new Map();

bot.command("start", async (ctx) => {
  const token = ctx.match?.trim() || "test-" + ctx.chat.id;
  logins.set(token, { chatId: ctx.chat.id, verified: false });
  const kb = new Keyboard()
    .requestContact("📱 Поделиться номером")
    .oneTime()
    .resized();
  return ctx.reply("Привет! Для входа нажми кнопку ниже и поделись номером:", {
    reply_markup: kb,
  });
});

bot.on("message:contact", async (ctx) => {
  const contact = ctx.message.contact;
  if (contact.user_id !== ctx.from.id) {
    return ctx.reply("Нужно отправить свой номер кнопкой «Поделиться номером».");
  }
  let found = false;
  for (const [, v] of logins) {
    if (v.chatId === ctx.chat.id && !v.verified) {
      v.verified = true;
      v.phone = contact.phone_number;
      found = true;
    }
  }
  if (!found) return ctx.reply("Напиши /start, чтобы начать вход.");
  return ctx.reply("Готово! Вход подтверждён.", {
    reply_markup: { remove_keyboard: true },
  });
});

bot.on("message:text", (ctx) =>
  ctx.reply("Напиши /start, чтобы войти.")
);

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
