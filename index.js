// ==================== ИМПОРТЫ ====================  
const TelegramBot = require('node-telegram-bot-api');  
const Database = require('better-sqlite3');  
const crypto = require('crypto');  
const fs = require('fs');  
  
// ==================== НАСТРОЙКИ ====================  
const BOT_TOKEN = process.env.TELEGRAM_TOKEN || "8383487446:AAFDsaezJ2-YvllFZ3eLJgb9Jwd3Swtk9VA";  
const ADMIN_ID = 8723208814;  
  
if (!BOT_TOKEN) {  
    console.error("Ошибка: переменная TELEGRAM_TOKEN не установлена!");  
    process.exit(1);  
}  
  
// --- Реквизиты для оплаты ---  
const CARD_NUMBER = "2200 1536 2364 5513";  
const CARD_HOLDER = "Получатель: Алексей М.";  
const PAYMENT_DETAILS = `💳 Карта: \`${CARD_NUMBER}\`\n${CARD_HOLDER}`;  
  
// Тарифы: tariff_key -> { name, days, price }  
const TARIFFS = {  
    "50":  { name: "3 дня",     days: 3,     price: 50 },  
    "200": { name: "1 месяц",   days: 30,    price: 200 },  
    "600": { name: "Навсегда",  days: 36500, price: 600 },  
};  
  
const bot = new TelegramBot(BOT_TOKEN, { polling: true });  
  
// ==================== БАЗА ДАННЫХ ====================  
// Railway: используем /data/subscriptions.db, если папка существует (Volume)  
// Локально: используем ./subscriptions.db  
const DB_FILE = fs.existsSync("/data") ? "/data/subscriptions.db" : "subscriptions.db";  
const db = new Database(DB_FILE);  
  
function initDb() {  
    db.exec(`  
        CREATE TABLE IF NOT EXISTS users (  
            user_id    INTEGER PRIMARY KEY,  
            username   TEXT,  
            sub_until  TEXT,  
            total_paid INTEGER DEFAULT 0  
        );  
    `);  
    db.exec(`  
        CREATE TABLE IF NOT EXISTS payments (  
            order_id   TEXT PRIMARY KEY,  
            user_id    INTEGER,  
            tariff     TEXT,  
            amount     INTEGER,  
            status     TEXT,  
            created_at TEXT,  
            paid_at    TEXT  
        );  
    `);  
}  
  
function getUser(userId) {  
    return db.prepare("SELECT user_id, username, sub_until, total_paid FROM users WHERE user_id = ?").get(userId);  
}  
  
function upsertUser(userId, username = null) {  
    db.prepare("INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)").run(userId, username);  
    if (username) {  
        db.prepare("UPDATE users SET username = ? WHERE user_id = ?").run(username, userId);  
    }  
}  
  
function setSubscription(userId, days) {  
    const row = db.prepare("SELECT sub_until FROM users WHERE user_id = ?").get(userId);  
    const now = new Date();  
    let start = now;  
  
    if (row && row.sub_until) {  
        const current = new Date(row.sub_until);  
        if (current > now) {  
            start = current;  
        }  
    }  
  
    const newUntil = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);  
    db.prepare("UPDATE users SET sub_until = ? WHERE user_id = ?").run(newUntil.toISOString(), userId);  
    return newUntil;  
}  
  
function isSubActive(userId) {  
    const row = getUser(userId);  
    if (!row || !row.sub_until) return false;  
    return new Date(row.sub_until) > new Date();  
}  
  
function createOrder(userId, tariffKey) {  
    const orderId = crypto.randomBytes(5).toString('hex');  
    const tariff = TARIFFS[tariffKey];  
    db.prepare(  
        "INSERT INTO payments (order_id, user_id, tariff, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"  
    ).run(orderId, userId, tariffKey, tariff.price, "pending", new Date().toISOString());  
    return orderId;  
}  
  
function confirmOrder(orderId) {  
    const row = db.prepare("SELECT user_id, tariff, amount FROM payments WHERE order_id = ?").get(orderId);  
    if (!row) return null;  
  
    const tariff = TARIFFS[row.tariff];  
    db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE order_id = ?")  
        .run(new Date().toISOString(), orderId);  
    db.prepare("UPDATE users SET total_paid = total_paid + ? WHERE user_id = ?")  
        .run(row.amount, row.user_id);  
    return setSubscription(row.user_id, tariff.days);  
}  
  
function rejectOrder(orderId) {  
    db.prepare("UPDATE payments SET status = 'rejected' WHERE order_id = ?").run(orderId);  
}  
  
function getPendingOrders() {  
    return db.prepare(  
        "SELECT order_id, user_id, tariff, amount, created_at FROM payments WHERE status = 'pending' ORDER BY created_at DESC"  
    ).all();  
}  
  
// ==================== КЛАВИАТУРЫ ====================  
function mainMenu() {  
    return {  
        reply_markup: {  
            keyboard: [  
                [{ text: "🔑 Войти" }, { text: "🛒 Купить" }, { text: "ℹ️ Помощь" }]  
            ],  
            resize_keyboard: true  
        }  
    };  
}  
  
function buyMenu() {  
    return {  
        reply_markup: {  
            inline_keyboard: [  
                [{ text: "50 ₽ — 3 дня", callback_data: "buy_50" }],  
                [{ text: "200 ₽ — 1 месяц", callback_data: "buy_200" }],  
                [{ text: "600 ₽ — навсегда", callback_data: "buy_600" }],  
                [{ text: "⬅️ Назад", callback_data: "back" }],  
            ]  
        }  
    };  
}  
  
// ==================== ХЭНДЛЕРЫ ====================  
bot.onText(/\/start/, (msg) => {  
    upsertUser(msg.from.id, msg.from.username);  
    bot.sendMessage(  
        msg.chat.id,  
        "👋 Добро пожаловать в J.A.R.V.I.S!\n\n" +  
        "Это бот для покупки подписки на приложение.\n" +  
        "Выберите действие в меню ниже.",  
        mainMenu()  
    );  
});  
  
bot.on('message', (msg) => {  
    const text = msg.text;  
    if (!text) return;  
  
    if (text === "🔑 Войти") {  
        upsertUser(msg.from.id, msg.from.username);  
        if (isSubActive(msg.from.id)) {  
            const row = getUser(msg.from.id);  
            const until = new Date(row.sub_until).toLocaleString('ru-RU');  
            bot.sendMessage(  
                msg.chat.id,  
                `✅ Подписка активна до ${until}.\n\n` +  
                `Ваш ключ доступа: \`${msg.from.id}\`\n\n` +  
                "Скопируйте его и введите в приложении J.A.R.V.I.S.",  
                { parse_mode: "Markdown", ...mainMenu() }  
            );  
        } else {  
            bot.sendMessage(  
                msg.chat.id,  
                "❌ У вас нет активной подписки.\nНажмите «🛒 Купить», чтобы оформить доступ.",  
                mainMenu()  
            );  
        }  
    }  
  
    if (text === "🛒 Купить") {  
        bot.sendMessage(msg.chat.id, "Выберите тариф:", buyMenu());  
    }  
  
    if (text === "ℹ️ Помощь") {  
        bot.sendMessage(  
            msg.chat.id,  
            "ℹ️ Помощь\n\n" +  
            "• «🔑 Войти» — получить ключ, если подписка активна.\n" +  
            "• «🛒 Купить» — выбрать тариф и оплатить.\n\n" +  
            `Оплата переводом на карту:\n${CARD_NUMBER}\n\n` +  
            "В комментарии к переводу обязательно укажите номер заказа.",  
            mainMenu()  
        );  
    }  
  
    // Команды администратора  
    if (text.startsWith("/confirm_")) {  
        if (msg.from.id !== ADMIN_ID) return;  
        const orderId = text.replace("/confirm_", "").trim();  
        const until = confirmOrder(orderId);  
        if (until) {  
            const row = db.prepare("SELECT user_id FROM payments WHERE order_id = ?").get(orderId);  
            bot.sendMessage(ADMIN_ID, `✅ Заказ \`${orderId}\` подтверждён. Подписка до ${until.toLocaleDateString('ru-RU')}.`, { parse_mode: "Markdown" });  
            if (row) {  
                bot.sendMessage(  
                    row.user_id,  
                    `🎉 Оплата подтверждена! Подписка активна до ${until.toLocaleString('ru-RU')}.\n\n` +  
                    `Ваш ключ доступа: \`${row.user_id}\`\n\n` +  
                    "Скопируйте его и введите в приложении J.A.R.V.I.S.",  
                    { parse_mode: "Markdown", ...mainMenu() }  
                );  
            }  
        } else {  
            bot.sendMessage(ADMIN_ID, `❌ Заказ \`${orderId}\` не найден.`, { parse_mode: "Markdown" });  
        }  
    }  
  
    if (text.startsWith("/reject_")) {  
        if (msg.from.id !== ADMIN_ID) return;  
        const orderId = text.replace("/reject_", "").trim();  
        rejectOrder(orderId);  
        bot.sendMessage(ADMIN_ID, `🚫 Заказ \`${orderId}\` отклонён.`, { parse_mode: "Markdown" });  
        const row = db.prepare("SELECT user_id FROM payments WHERE order_id = ?").get(orderId);  
        if (row) {  
            bot.sendMessage(row.user_id, "❌ Ваш платёж не подтверждён. Свяжитесь с администратором.");  
        }  
    }  
  
    if (text === "/pending") {  
        if (msg.from.id !== ADMIN_ID) return;  
        const rows = getPendingOrders();  
        if (!rows.length) {  
            bot.sendMessage(ADMIN_ID, "Нет ожидающих заказов.");  
            return;  
        }  
        let out = "🕓 Ожидающие заказы:\n\n";  
        for (const r of rows) {  
            out += `№\`${r.order_id}\` — ${r.user_id} — ${TARIFFS[r.tariff].name} — ${r.amount} ₽\n`;  
        }  
        bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });  
    }  
});  
  
// ==================== CALLBACK QUERY ====================  
bot.on('callback_query', (query) => {  
    const data = query.data;  
    const chatId = query.message.chat.id;  
    const msgId = query.message.message_id;  
  
    if (data === "back") {  
        bot.editMessageText("Выберите действие в меню ниже.", { chat_id: chatId, message_id: msgId });  
        bot.sendMessage(chatId, "Меню:", mainMenu());  
        return;  
    }  
  
    if (data.startsWith("buy_")) {  
        const tariffKey = data.split("_")[1];  
        const tariff = TARIFFS[tariffKey];  
        const orderId = createOrder(query.from.id, tariffKey);  
  
        bot.editMessageText(  
            `🧾 Заказ №\`${orderId}\`\n` +  
            `Тариф: ${tariff.name}\n` +  
            `Сумма: ${tariff.price} ₽\n\n` +  
            `Оплатите по реквизитам:\n${PAYMENT_DETAILS}\n\n` +  
            `⚠️ В комментарии к переводу обязательно укажите:\n\`${orderId}\`\n\n` +  
            `После оплаты нажмите кнопку ниже и отправьте чек.`,  
            {  
                chat_id: chatId,  
                message_id: msgId,  
                parse_mode: "Markdown",  
                reply_markup: {  
                    inline_keyboard: [  
                        [{ text: "📷 Я оплатил", callback_data: `paid_${orderId}` }]  
                    ]  
                }  
            }  
        );  
    }  
  
    if (data.startsWith("paid_")) {  
        const orderId = data.split("_")[1];  
        bot.sendMessage(  
            chatId,  
            `Отправьте скриншот или чек об оплате заказа №\`${orderId}\`.\nАдминистратор проверит и активирует подписку.`,  
            { parse_mode: "Markdown" }  
        );  
        bot.sendMessage(  
            ADMIN_ID,  
            `💰 Новый платёж!\n` +  
            `Заказ: \`${orderId}\`\n` +  
            `Пользователь: ${query.from.id} (@${query.from.username || "нет"})\n\n` +  
            `Проверьте перевод и подтвердите:\n/confirm_${orderId}\n` +  
            `Или отклоните:\n/reject_${orderId}`,  
            { parse_mode: "Markdown" }  
        );  
    }  
  
    bot.answerCallbackQuery(query.id);  
});  
  
// ==================== ЧЕКИ ====================  
bot.on('photo', (msg) => {  
    bot.sendMessage(msg.chat.id, "✅ Чек получен. Ожидайте подтверждения администратора.");  
    bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);  
});  
  
bot.on('document', (msg) => {  
    bot.sendMessage(msg.chat.id, "✅ Чек получен. Ожидайте подтверждения администратора.");  
    bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);  
});  
  
// ==================== ЗАПУСК ====================  
initDb();  
console.log("Бот запущен...");  
console.log(`База данных: ${DB_FILE}`);  
