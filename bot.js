import { Bot } from "grammy";
import express from "express";
import { Resend } from "resend";

const bot = new Bot(process.env.TELEGRAM_TOKEN);
const resend = new Resend(process.env.RESEND_API_KEY);

const logins = new Map();

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

bot.command("start", async (ctx) => {
  const token = ctx.match?.trim() || "test-" + ctx.chat.id;
  logins.set(token, { state: "await_email", chatId: ctx.chat.id });
  return ctx.reply("Привет! Для входа введи свою почту:");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  let entry = null;
  for (const [, v] of logins) {
    if (v.chatId === chatId && !v.verified) { entry = v; break; }
  }

  if (!entry) return ctx.reply("Напиши /start, чтобы начать вход.");

  if (entry.state === "await_email") {
    if (!text.includes("@")) return ctx.reply("Это не похоже на почту, попробуй ещё раз.");
    entry.email = text;
    entry.code = genCode();
    entry.state = "await_code";
    try {
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: text,
        subject: "Код входа",
        text: `Твой код: ${entry.code}`,
      });
      return ctx.reply("Код отправлен на почту. Введи его сюда:");
    } catch (e) {
      console.error(e);
      return ctx.reply("Не получилось отправить письмо, попробуй позже.");
    }
  }

  if (entry.state === "await_code") {
    if (text === entry.code) {
      entry.verified = true;
      return ctx.reply("Готово! Вход подтверждён.");
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
