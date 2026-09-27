import { Bot } from "grammy";
import express from "express";
import nodemailer from "nodemailer";

const bot = new Bot(process.env.TELEGRAM_TOKEN);
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = "gemini-flash-lite-latest";
const SYSTEM_PROMPT = "Ты дружелюбный помощник в Telegram. Отвечай кратко и по делу.";

const histories = new Map();
const MAX_MESSAGES = 20;

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
  return ctx.reply("Привет! Напиши мне что-нибудь, и я отвечу.");
});

bot.command("reset", (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply("История очищена.");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  let entry = null;
  for (const [, v] of logins) {
    if (v.chatId === chatId && !v.verified) { entry = v; break; }
  }

  if (entry && entry.state === "await_email") {
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

  if (entry && entry.state === "await_code") {
    if (text === entry.code) {
      entry.verified = true;
      return ctx.reply("Готово! Возвращайся в приложение.");
    }
    return ctx.reply("Код неверный, попробуй ещё раз.");
  }

  const history = histories.get(chatId) ?? [];
  history.push({ role: "user", parts: [{ text }] });
  await ctx.replyWithChatAction("typing");
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: history,
        }),
      }
    );
    const data = await res.json();
    const answer = data.candidates[0].content.parts[0].text;
    history.push({ role: "model", parts: [{ text: answer }] });
    histories.set(chatId, history.slice(-MAX_MESSAGES));
    await ctx.reply(answer);
  } catch (err) {
    console.error(err);
    history.pop();
    await ctx.reply("Что-то пошло не так, попробуй ещё раз.");
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
