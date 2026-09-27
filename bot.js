import { Bot } from "grammy";
import express from "express";
import nodemailer from "nodemailer";

const bot = new Bot(process.env.TELEGRAM_TOKEN);

// логин: token -> { state, email, code, verified }
const logins = new Map();

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

bot.command("start", async (ctx) => {
  const token = ctx.match?.trim();
  if (token) {
    logins.set(token, { state: "await_email", chatId: ctx.chat.id });
    return ctx.reply("Привет! Для входа введи свою почту:");
  }
  return ctx.reply("Привет! Чтобы войти, открой это в приложении.");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  let entry = null;
  for (const [, v] of logins) {
    if (v.chatId === chatId && !v.verified) { entry = v; break; }
  }

  if (!entry) {
    return ctx.reply("Чтобы войти, открой ссылку из приложения.");
  }

  if (entry.state === "await_email") {
    if (!text.includes("@")) return ctx.reply("Это не похоже на почту, попробуй ещё раз.");
    entry.email = text;
    entry.code = genCode();
    entry.state = "await_code";
    try {
      await mailer.sendMail({
        from: process.env.GMAIL_USER,
        to: text,
        subject: "Код входа",
        text: `Твой код: ${entry.code}`,
      });
      return ctx.reply("Код отправлен на почту. Введи его сюда:");
    } catch (e) {
      console.error(e);
      return ctx.reply("Не получилось отправить письмо, проверь адрес и попробуй снова.");
    }
  }

  if (entry.state === "await_code") {
    if (text === entry.code) {
      entry.verified = true;
      return ctx.reply("Готово! Возвращайся в приложение.");
    }
    return ctx.reply("Код неверный, попробуй ещё раз.");
  }
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
  res.json({ verified: !!entry.verified, email: entry.email ?? null });
});
app.listen(process.env.PORT || 3000, () => console.log("HTTP запущен"));
