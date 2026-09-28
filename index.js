// ==================== ИМПОРТЫ ====================
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// ==================== НАСТРОЙКИ ====================

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

// ДВА АДМИНА ОТДЕЛЬНО
const ADMIN_ID_1 = 8723208814;
const ADMIN_ID_2 = 123456789; // <-- сюда ID второго админа

const ADMIN_IDS = [
    ADMIN_ID_1,
    ADMIN_ID_2
];

const CARD_NUMBER =
    process.env.CARD_NUMBER || "2200 1536 2364 5513";

const CARD_HOLDER =
    process.env.CARD_HOLDER || "Получатель: Алексей М.";

if (!BOT_TOKEN) {
    console.error("❌ TELEGRAM_TOKEN не установлен");
    process.exit(1);
}

// ==================== ТАРИФЫ ====================

const TARIFFS = {
    "50": {
        name: "3 дня",
        days: 3,
        price: 50
    },

    "200": {
        name: "1 месяц",
        days: 30,
        price: 200
    },

    "600": {
        name: "Навсегда",
        days: 36500,
        price: 600
    }
};

// ==================== БОТ ====================

const bot = new TelegramBot(BOT_TOKEN, {
    polling: true
});

// ==================== БАЗА ====================

const DB_FILE = fs.existsSync("/data")
    ? "/data/subscriptions.db"
    : "./subscriptions.db";

const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            sub_until TEXT,
            total_paid INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS payments (
            order_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            tariff TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            paid_at TEXT
        );
    `);
}

// ==================== АДМИНЫ ====================

function isAdmin(userId) {
    return ADMIN_IDS.includes(Number(userId));
}

async function sendToAllAdmins(text, options = {}) {
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.sendMessage(
                adminId,
                text,
                options
            );
        } catch (error) {
            console.error(
                `Ошибка отправки админу ${adminId}:`,
                error.message
            );
        }
    }
}

// ==================== ПОЛЬЗОВАТЕЛИ ====================

function upsertUser(userId, username = null) {

    db.prepare(`
        INSERT OR IGNORE INTO users
        (user_id, username)
        VALUES (?, ?)
    `).run(userId, username);

    if (username) {
        db.prepare(`
            UPDATE users
            SET username = ?
            WHERE user_id = ?
        `).run(username, userId);
    }
}

function getUser(userId) {

    return db.prepare(`
        SELECT *
        FROM users
        WHERE user_id = ?
    `).get(userId);
}

// ==================== ПОДПИСКА ====================

function isSubActive(userId) {

    const user = getUser(userId);

    if (!user || !user.sub_until) {
        return false;
    }

    return new Date(user.sub_until) > new Date();
}

function setSubscription(userId, days) {

    const user = getUser(userId);

    const now = new Date();

    let start = now;

    if (user && user.sub_until) {

        const current = new Date(user.sub_until);

        if (current > now) {
            start = current;
        }
    }

    const until = new Date(
        start.getTime() +
        days * 24 * 60 * 60 * 1000
    );

    db.prepare(`
        UPDATE users
        SET sub_until = ?
        WHERE user_id = ?
    `).run(
        until.toISOString(),
        userId
    );

    return until;
}

// ==================== ЗАКАЗЫ ====================

function createOrder(userId, tariffKey) {

    const tariff = TARIFFS[tariffKey];

    if (!tariff) {
        throw new Error("Тариф не найден");
    }

    const orderId = crypto
        .randomBytes(5)
        .toString("hex")
        .toUpperCase();

    db.prepare(`
        INSERT INTO payments
        (
            order_id,
            user_id,
            tariff,
            amount,
            status,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        orderId,
        userId,
        tariffKey,
        tariff.price,
        "pending",
        new Date().toISOString()
    );

    return orderId;
}

function getOrder(orderId) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE order_id = ?
    `).get(orderId);
}

function getPendingOrder(userId) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE user_id = ?
        AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
    `).get(userId);
}

// ==================== ПОДТВЕРЖДЕНИЕ ====================

function confirmOrder(orderId) {

    const order = getOrder(orderId);

    if (!order) {
        return {
            success: false,
            reason: "not_found"
        };
    }

    if (order.status !== "pending") {
        return {
            success: false,
            reason: "already_processed"
        };
    }

    const tariff = TARIFFS[order.tariff];

    if (!tariff) {
        return {
            success: false,
            reason: "tariff_not_found"
        };
    }

    const until = setSubscription(
        order.user_id,
        tariff.days
    );

    db.prepare(`
        UPDATE payments
        SET
            status = 'paid',
            paid_at = ?
        WHERE order_id = ?
        AND status = 'pending'
    `).run(
        new Date().toISOString(),
        orderId
    );

    db.prepare(`
        UPDATE users
        SET total_paid = total_paid + ?
        WHERE user_id = ?
    `).run(
        order.amount,
        order.user_id
    );

    return {
        success: true,
        userId: order.user_id,
        until: until
    };
}

// ==================== ОТКЛОНЕНИЕ ====================

function rejectOrder(orderId) {

    const order = getOrder(orderId);

    if (!order) {
        return {
            success: false,
            reason: "not_found"
        };
    }

    if (order.status !== "pending") {
        return {
            success: false,
            reason: "already_processed"
        };
    }

    db.prepare(`
        UPDATE payments
        SET status = 'rejected'
        WHERE order_id = ?
        AND status = 'pending'
    `).run(orderId);

    return {
        success: true,
        userId: order.user_id
    };
}

// ==================== КЛАВИАТУРЫ ====================

function mainMenu() {

    return {
        reply_markup: {
            keyboard: [
                [
                    {
                        text: "🔑 Войти"
                    },
                    {
                        text: "🛒 Купить"
                    }
                ],
                [
                    {
                        text: "ℹ️ Помощь"
                    }
                ]
            ],
            resize_keyboard: true
        }
    };
}

function buyMenu() {

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "50 ₽ — 3 дня",
                        callback_data: "buy_50"
                    }
                ],
                [
                    {
                        text: "200 ₽ — 1 месяц",
                        callback_data: "buy_200"
                    }
                ],
                [
                    {
                        text: "600 ₽ — навсегда",
                        callback_data: "buy_600"
                    }
                ],
                [
                    {
                        text: "⬅️ Назад",
                        callback_data: "back"
                    }
                ]
            ]
        }
    };
}

function adminButtons(orderId) {

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "✅ Подтвердить",
                        callback_data:
                            `confirm_${orderId}`
                    },
                    {
                        text: "❌ Отклонить",
                        callback_data:
                            `reject_${orderId}`
                    }
                ]
            ]
        }
    };
}

// ==================== START ====================

bot.onText(/^\/start/, async (msg) => {

    upsertUser(
        msg.from.id,
        msg.from.username || null
    );

    await bot.sendMessage(
        msg.chat.id,

        "👋 Добро пожаловать в J.A.R.V.I.S!\n\n" +
        "Это бот для покупки подписки.\n\n" +
        "Выберите действие:",

        mainMenu()
    );
});

// ==================== ID ====================

bot.onText(/^\/id$/, async (msg) => {

    await bot.sendMessage(
        msg.chat.id,
        `🆔 Ваш Telegram ID:\n\n\`${msg.from.id}\``,
        {
            parse_mode: "Markdown"
        }
    );
});

// ==================== PENDING ====================

bot.onText(/^\/pending$/, async (msg) => {

    if (!isAdmin(msg.from.id)) {
        return;
    }

    const rows = db.prepare(`
        SELECT *
        FROM payments
        WHERE status = 'pending'
        ORDER BY created_at DESC
    `).all();

    if (!rows.length) {

        await bot.sendMessage(
            msg.chat.id,
            "🕓 Ожидающих заказов нет."
        );

        return;
    }

    let text = "🕓 Ожидающие заказы:\n\n";

    for (const row of rows) {

        const tariff = TARIFFS[row.tariff];

        text +=
            `🧾 Заказ: ${row.order_id}\n` +
            `👤 User ID: ${row.user_id}\n` +
            `📦 Тариф: ${tariff.name}\n` +
            `💰 Сумма: ${row.amount} ₽\n\n`;
    }

    await bot.sendMessage(
        msg.chat.id,
        text
    );
});

// ==================== ОСНОВНЫЕ КНОПКИ ====================

bot.on("message", async (msg) => {

    if (!msg.text) {
        return;
    }

    const text = msg.text;

    upsertUser(
        msg.from.id,
        msg.from.username || null
    );

    // Войти
    if (text === "🔑 Войти") {

        if (!isSubActive(msg.from.id)) {

            await bot.sendMessage(
                msg.chat.id,
                "❌ У вас нет активной подписки.\n\n" +
                "Нажмите «🛒 Купить».",
                mainMenu()
            );

            return;
        }

        const user = getUser(msg.from.id);

        const until = new Date(
            user.sub_until
        ).toLocaleString("ru-RU");

        await bot.sendMessage(
            msg.chat.id,

            `✅ Подписка активна до:\n${until}\n\n` +
            `🔑 Ваш ключ доступа:\n\n` +
            `\`${msg.from.id}\`\n\n` +
            `Введите этот ключ в приложении J.A.R.V.I.S.`,

            {
                parse_mode: "Markdown",
                ...mainMenu()
            }
        );

        return;
    }

    // Купить
    if (text === "🛒 Купить") {

        await bot.sendMessage(
            msg.chat.id,
            "🛒 Выберите тариф:",
            buyMenu()
        );

        return;
    }

    // Помощь
    if (text === "ℹ️ Помощь") {

        await bot.sendMessage(
            msg.chat.id,

            "ℹ️ Помощь\n\n" +
            "🔑 Войти — получить ключ.\n" +
            "🛒 Купить — приобрести подписку.\n\n" +
            "После оплаты отправьте чек боту.",

            mainMenu()
        );

        return;
    }
});

// ==================== CALLBACK ====================

bot.on("callback_query", async (query) => {

    try {

        const data = query.data;

        const chatId =
            query.message.chat.id;

        const messageId =
            query.message.message_id;

        // Назад
        if (data === "back") {

            await bot.answerCallbackQuery(query.id);

            await bot.sendMessage(
                chatId,
                "📋 Главное меню:",
                mainMenu()
            );

            return;
        }

        // Покупка
        if (data.startsWith("buy_")) {

            const tariffKey =
                data.substring(4);

            const tariff =
                TARIFFS[tariffKey];

            if (!tariff) {
                return;
            }

            upsertUser(
                query.from.id,
                query.from.username || null
            );

            const orderId =
                createOrder(
                    query.from.id,
                    tariffKey
                );

            await bot.answerCallbackQuery(query.id);

            await bot.editMessageText(

                `🧾 Заказ №\`${orderId}\`\n\n` +

                `📦 Тариф: ${tariff.name}\n` +
                `💰 Сумма: ${tariff.price} ₽\n\n` +

                `💳 Реквизиты для оплаты:\n\n` +

                `Карта: \`${CARD_NUMBER}\`\n` +
                `${CARD_HOLDER}\n\n` +

                `⚠️ После перевода сохраните чек.\n\n` +
                `Затем нажмите «📷 Я оплатил».`,

                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "Markdown",

                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: "📷 Я оплатил",
                                    callback_data:
                                        `paid_${orderId}`
                                }
                            ],
                            [
                                {
                                    text: "⬅️ Назад",
                                    callback_data: "back"
                                }
                            ]
                        ]
                    }
                }
            );

            return;
        }

        // Оплата
        if (data.startsWith("paid_")) {

            const orderId =
                data.substring(5);

            const order =
                getOrder(orderId);

            if (!order) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Заказ не найден",
                        show_alert: true
                    }
                );

                return;
            }

            await bot.answerCallbackQuery(query.id);

            await bot.sendMessage(
                chatId,

                `📷 Отправьте чек сюда.\n\n` +
                `🧾 Заказ: \`${orderId}\`\n` +
                `💰 Сумма: ${order.amount} ₽`,

                {
                    parse_mode: "Markdown"
                }
            );

            return;
        }

        // ==================== ПОДТВЕРДИТЬ ====================

        if (data.startsWith("confirm_")) {

            if (!isAdmin(query.from.id)) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Нет доступа",
                        show_alert: true
                    }
                );

                return;
            }

            const orderId =
                data.substring(8);

            const result =
                confirmOrder(orderId);

            if (!result.success) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text:
                            result.reason ===
                            "already_processed"
                                ? "Заказ уже обработан"
                                : "Заказ не найден",
                        show_alert: true
                    }
                );

                return;
            }

            await bot.answerCallbackQuery(
                query.id,
                {
                    text: "Оплата подтверждена ✅"
                }
            );

            try {

                await bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: []
                    },
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );

            } catch (e) {}

            const until =
                result.until.toLocaleString("ru-RU");

            // Пользователю
            await bot.sendMessage(

                result.userId,

                `🎉 Оплата подтверждена!\n\n` +
                `📅 Подписка активна до:\n${until}\n\n` +
                `🔑 Ваш ключ:\n` +
                `\`${result.userId}\``,

                {
                    parse_mode: "Markdown",
                    ...mainMenu()
                }
            );

            // Обоим админам
            await sendToAllAdmins(

                `✅ Заказ подтверждён\n\n` +
                `🧾 Заказ: ${orderId}\n` +
                `👤 Пользователь: ${result.userId}\n` +
                `📅 До: ${until}`
            );

            return;
        }

        // ==================== ОТКЛОНИТЬ ====================

        if (data.startsWith("reject_")) {

            if (!isAdmin(query.from.id)) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Нет доступа",
                        show_alert: true
                    }
                );

                return;
            }

            const orderId =
                data.substring(7);

            const result =
                rejectOrder(orderId);

            if (!result.success) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Заказ уже обработан",
                        show_alert: true
                    }
                );

                return;
            }

            await bot.answerCallbackQuery(
                query.id,
                {
                    text: "Заказ отклонён ❌"
                }
            );

            try {

                await bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: []
                    },
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );

            } catch (e) {}

            await bot.sendMessage(

                result.userId,

                `❌ Оплата заказа \`${orderId}\` не подтверждена.\n\n` +
                `Свяжитесь с администратором.`,

                {
                    parse_mode: "Markdown",
                    ...mainMenu()
                }
            );

            await sendToAllAdmins(

                `❌ Заказ отклонён\n\n` +
                `🧾 Заказ: ${orderId}\n` +
                `👤 Пользователь: ${result.userId}`
            );

            return;
        }

    } catch (error) {

        console.error(
            "Callback error:",
            error
        );

        try {
            await bot.answerCallbackQuery(
                query.id,
                {
                    text: "Произошла ошибка",
                    show_alert: true
                }
            );
        } catch (e) {}
    }
});

// ==================== ЧЕК: ФОТО ====================

bot.on("photo", async (msg) => {

    const order =
        getPendingOrder(msg.from.id);

    if (!order) {

        await bot.sendMessage(
            msg.chat.id,
            "❌ У вас нет ожидающего заказа."
        );

        return;
    }

    const username =
        msg.from.username
            ? `@${msg.from.username}`
            : "нет";

    await bot.sendMessage(
        msg.chat.id,

        `✅ Чек получен!\n\n` +
        `🧾 Заказ: \`${order.order_id}\`\n\n` +
        `Ожидайте проверки администратора.`,

        {
            parse_mode: "Markdown"
        }
    );

    const adminText =

        `💰 НОВЫЙ ПЛАТЁЖ\n\n` +

        `🧾 Заказ: \`${order.order_id}\`\n` +

        `👤 User ID: ${msg.from.id}\n` +

        `👤 Username: ${username}\n` +

        `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +

        `💰 Сумма: ${order.amount} ₽`;

    // Отправляем обоим админам
    for (const adminId of ADMIN_IDS) {

        try {

            await bot.sendMessage(
                adminId,
                adminText,
                {
                    parse_mode: "Markdown"
                }
            );

            await bot.forwardMessage(
                adminId,
                msg.chat.id,
                msg.message_id
            );

            await bot.sendMessage(
                adminId,

                `Что сделать с заказом \`${order.order_id}\`?`,

                {
                    parse_mode: "Markdown",
                    ...adminButtons(order.order_id)
                }
            );

        } catch (error) {

            console.error(
                `Ошибка отправки админу ${adminId}:`,
                error.message
            );
        }
    }
});

// ==================== ЧЕК: ФАЙЛ ====================

bot.on("document", async (msg) => {

    const order =
        getPendingOrder(msg.from.id);

    if (!order) {

        await bot.sendMessage(
            msg.chat.id,
            "❌ У вас нет ожидающего заказа."
        );

        return;
    }

    const username =
        msg.from.username
            ? `@${msg.from.username}`
            : "нет";

    await bot.sendMessage(
        msg.chat.id,

        `✅ Чек получен!\n\n` +
        `🧾 Заказ: \`${order.order_id}\`\n\n` +
        `Ожидайте проверки администратора.`,

        {
            parse_mode: "Markdown"
        }
    );

    const adminText =

        `💰 НОВЫЙ ПЛАТЁЖ\n\n` +

        `🧾 Заказ: \`${order.order_id}\`\n` +

        `👤 User ID: ${msg.from.id}\n` +

        `👤 Username: ${username}\n` +

        `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +

        `💰 Сумма: ${order.amount} ₽`;

    for (const adminId of ADMIN_IDS) {

        try {

            await bot.sendMessage(
                adminId,
                adminText,
                {
                    parse_mode: "Markdown"
                }
            );

            await bot.forwardMessage(
                adminId,
                msg.chat.id,
                msg.message_id
            );

            await bot.sendMessage(
                adminId,

                `Что сделать с заказом \`${order.order_id}\`?`,

                {
                    parse_mode: "Markdown",
                    ...adminButtons(order.order_id)
                }
            );

        } catch (error) {

            console.error(
                `Ошибка админу ${adminId}:`,
                error.message
            );
        }
    }
});

// ==================== ЗАПУСК ====================

initDb();

console.log("=================================");
console.log("🤖 J.A.R.V.I.S BOT ЗАПУЩЕН");
console.log("👑 ADMIN 1:", ADMIN_ID_1);
console.log("👑 ADMIN 2:", ADMIN_ID_2);
console.log("💾 DATABASE:", DB_FILE);
console.log("=================================");
