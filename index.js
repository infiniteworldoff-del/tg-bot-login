// =====================================================
// J.A.R.V.I.S — Telegram Bot
// Railway + SQLite
// =====================================================

const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// =====================================================
// НАСТРОЙКИ
// =====================================================

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

const ADMIN_ID = Number(process.env.ADMIN_ID || "8723208814");

// Реквизиты берём из Railway Variables
const CARD_NUMBER = process.env.CARD_NUMBER || "2200 1536 2364 5513";
const CARD_HOLDER = process.env.CARD_HOLDER || "Получатель: Алексей М.";

if (!BOT_TOKEN) {
    console.error("❌ TELEGRAM_TOKEN не установлен!");
    process.exit(1);
}

if (!ADMIN_ID) {
    console.error("❌ ADMIN_ID не установлен!");
    process.exit(1);
}

// =====================================================
// ТАРИФЫ
// =====================================================

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

// =====================================================
// TELEGRAM
// =====================================================

const bot = new TelegramBot(BOT_TOKEN, {
    polling: true
});

console.log("🚀 Запуск бота...");

// =====================================================
// DATABASE
// =====================================================

// Railway Volume должен быть подключён к /data

const DB_FILE = fs.existsSync("/data")
    ? "/data/subscriptions.db"
    : "./subscriptions.db";

const db = new Database(DB_FILE);

console.log(`📁 База данных: ${DB_FILE}`);

// =====================================================
// ИНИЦИАЛИЗАЦИЯ БД
// =====================================================

function initDb() {

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            sub_until TEXT,
            total_paid INTEGER DEFAULT 0
        );
    `);

    db.exec(`
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

// =====================================================
// USERS
// =====================================================

function getUser(userId) {

    return db
        .prepare(`
            SELECT
                user_id,
                username,
                sub_until,
                total_paid
            FROM users
            WHERE user_id = ?
        `)
        .get(userId);
}


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

// =====================================================
// ПОДПИСКА
// =====================================================

function setSubscription(userId, days) {

    const row = db
        .prepare(`
            SELECT sub_until
            FROM users
            WHERE user_id = ?
        `)
        .get(userId);

    const now = new Date();

    let start = now;

    if (row && row.sub_until) {

        const current = new Date(row.sub_until);

        if (current > now) {
            start = current;
        }
    }

    const newUntil = new Date(
        start.getTime() +
        days * 24 * 60 * 60 * 1000
    );

    db.prepare(`
        UPDATE users
        SET sub_until = ?
        WHERE user_id = ?
    `).run(
        newUntil.toISOString(),
        userId
    );

    return newUntil;
}


function isSubActive(userId) {

    const row = getUser(userId);

    if (!row || !row.sub_until) {
        return false;
    }

    return new Date(row.sub_until) > new Date();
}

// =====================================================
// ORDERS
// =====================================================

function createOrder(userId, tariffKey) {

    const tariff = TARIFFS[tariffKey];

    if (!tariff) {
        throw new Error("Неизвестный тариф");
    }

    const orderId = crypto
        .randomBytes(5)
        .toString("hex")
        .toUpperCase();

    db.prepare(`
        INSERT INTO payments (
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

    return db
        .prepare(`
            SELECT
                order_id,
                user_id,
                tariff,
                amount,
                status,
                created_at,
                paid_at
            FROM payments
            WHERE order_id = ?
        `)
        .get(orderId);
}


// =====================================================
// ПОДТВЕРЖДЕНИЕ ЗАКАЗА
// =====================================================

function confirmOrder(orderId) {

    const row = getOrder(orderId);

    if (!row) {
        return {
            success: false,
            reason: "not_found"
        };
    }

    // Защита от повторного подтверждения
    if (row.status !== "pending") {

        return {
            success: false,
            reason: "already_processed",
            status: row.status
        };
    }

    const tariff = TARIFFS[row.tariff];

    if (!tariff) {

        return {
            success: false,
            reason: "tariff_error"
        };
    }

    const transaction = db.transaction(() => {

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
            row.amount,
            row.user_id
        );

        return setSubscription(
            row.user_id,
            tariff.days
        );
    });

    const until = transaction();

    return {
        success: true,
        userId: row.user_id,
        until
    };
}


// =====================================================
// ОТКЛОНЕНИЕ
// =====================================================

function rejectOrder(orderId) {

    const row = getOrder(orderId);

    if (!row) {
        return {
            success: false,
            reason: "not_found"
        };
    }

    if (row.status !== "pending") {

        return {
            success: false,
            reason: "already_processed",
            status: row.status
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
        userId: row.user_id
    };
}


// =====================================================
// ОЖИДАЮЩИЕ ЗАКАЗЫ
// =====================================================

function getPendingOrders() {

    return db.prepare(`
        SELECT
            order_id,
            user_id,
            tariff,
            amount,
            status,
            created_at
        FROM payments
        WHERE status = 'pending'
        ORDER BY created_at DESC
    `).all();
}


// =====================================================
// АКТИВНЫЙ ЗАКАЗ ПОЛЬЗОВАТЕЛЯ
// =====================================================

function getLastPendingOrder(userId) {

    return db.prepare(`
        SELECT
            order_id,
            user_id,
            tariff,
            amount,
            status
        FROM payments
        WHERE user_id = ?
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
    `).get(userId);
}


// =====================================================
// КЛАВИАТУРЫ
// =====================================================

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


// =====================================================
// КНОПКИ АДМИНА
// =====================================================

function adminPaymentKeyboard(orderId) {

    return {
        reply_markup: {
            inline_keyboard: [

                [
                    {
                        text: "✅ Подтвердить",
                        callback_data: `admin_confirm_${orderId}`
                    },

                    {
                        text: "❌ Отклонить",
                        callback_data: `admin_reject_${orderId}`
                    }
                ]
            ]
        }
    };
}


// =====================================================
// START
// =====================================================

bot.onText(/^\/start(?:\s+.*)?$/, (msg) => {

    upsertUser(
        msg.from.id,
        msg.from.username || null
    );

    bot.sendMessage(
        msg.chat.id,

        "👋 Добро пожаловать в J.A.R.V.I.S!\n\n" +

        "Это бот для покупки подписки на приложение.\n\n" +

        "Выберите действие в меню ниже.",

        mainMenu()
    );
});


// =====================================================
// /ID
// =====================================================

bot.onText(/^\/id$/, (msg) => {

    bot.sendMessage(
        msg.chat.id,
        `🆔 Ваш Telegram ID:\n\`${msg.from.id}\``,
        {
            parse_mode: "Markdown"
        }
    );
});


// =====================================================
// ОСНОВНОЕ МЕНЮ
// =====================================================

bot.on("message", async (msg) => {

    const text = msg.text;

    if (!text) {
        return;
    }

    upsertUser(
        msg.from.id,
        msg.from.username || null
    );

    // =============================================
    // ВОЙТИ
    // =============================================

    if (text === "🔑 Войти") {

        if (isSubActive(msg.from.id)) {

            const row = getUser(msg.from.id);

            const until = new Date(
                row.sub_until
            ).toLocaleString("ru-RU");

            await bot.sendMessage(
                msg.chat.id,

                `✅ Подписка активна до:\n${until}\n\n` +

                `🔑 Ваш ключ доступа:\n` +

                `\`${msg.from.id}\`\n\n` +

                "Скопируйте его и введите в приложении J.A.R.V.I.S.",

                {
                    parse_mode: "Markdown",
                    ...mainMenu()
                }
            );

        } else {

            await bot.sendMessage(
                msg.chat.id,

                "❌ У вас нет активной подписки.\n\n" +

                "Нажмите «🛒 Купить», чтобы оформить доступ.",

                mainMenu()
            );
        }

        return;
    }


    // =============================================
    // КУПИТЬ
    // =============================================

    if (text === "🛒 Купить") {

        await bot.sendMessage(
            msg.chat.id,
            "🛒 Выберите тариф:",
            buyMenu()
        );

        return;
    }


    // =============================================
    // ПОМОЩЬ
    // =============================================

    if (text === "ℹ️ Помощь") {

        await bot.sendMessage(
            msg.chat.id,

            "ℹ️ Помощь\n\n" +

            "🔑 «Войти» — получить ключ при активной подписке.\n\n" +

            "🛒 «Купить» — выбрать тариф.\n\n" +

            "💳 После выбора тарифа бот покажет реквизиты.\n\n" +

            "📷 После оплаты отправьте чек через кнопку «Я оплатил».",

            mainMenu()
        );

        return;
    }


    // =============================================
    // /pending
    // =============================================

    if (text === "/pending") {

        if (msg.from.id !== ADMIN_ID) {
            return;
        }

        const rows = getPendingOrders();

        if (!rows.length) {

            await bot.sendMessage(
                ADMIN_ID,
                "🕓 Ожидающих заказов нет."
            );

            return;
        }

        let output =
            "🕓 Ожидающие заказы:\n\n";

        for (const row of rows) {

            const tariff = TARIFFS[row.tariff];

            output +=
                `№ \`${row.order_id}\`\n` +
                `👤 ID: ${row.user_id}\n` +
                `📦 Тариф: ${tariff.name}\n` +
                `💰 Сумма: ${row.amount} ₽\n\n`;
        }

        await bot.sendMessage(
            ADMIN_ID,
            output,
            {
                parse_mode: "Markdown"
            }
        );

        return;
    }
});


// =====================================================
// CALLBACK QUERY
// =====================================================

bot.on("callback_query", async (query) => {

    try {

        const data = query.data;

        const chatId =
            query.message.chat.id;

        const messageId =
            query.message.message_id;


        // =============================================
        // НАЗАД
        // =============================================

        if (data === "back") {

            await bot.answerCallbackQuery(
                query.id
            );

            await bot.editMessageText(
                "Выберите действие в меню ниже.",

                {
                    chat_id: chatId,
                    message_id: messageId
                }
            );

            await bot.sendMessage(
                chatId,
                "📋 Меню:",
                mainMenu()
            );

            return;
        }


        // =============================================
        // ПОКУПКА
        // =============================================

        if (data.startsWith("buy_")) {

            const tariffKey =
                data.split("_")[1];

            const tariff =
                TARIFFS[tariffKey];

            if (!tariff) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Ошибка тарифа",
                        show_alert: true
                    }
                );

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

            const paymentDetails =
                `💳 Карта: \`${CARD_NUMBER}\`\n` +
                `👤 ${CARD_HOLDER}`;

            await bot.answerCallbackQuery(
                query.id
            );

            await bot.editMessageText(

                `🧾 Заказ №\`${orderId}\`\n\n` +

                `📦 Тариф: ${tariff.name}\n` +

                `💰 Сумма: ${tariff.price} ₽\n\n` +

                `━━━━━━━━━━━━━━\n\n` +

                `💳 Реквизиты для оплаты:\n\n` +

                `${paymentDetails}\n\n` +

                `━━━━━━━━━━━━━━\n\n` +

                `⚠️ После перевода обязательно сохраните чек.\n\n` +

                `Затем нажмите кнопку «📷 Я оплатил».`,

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


        // =============================================
        // Я ОПЛАТИЛ
        // =============================================

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

            if (order.user_id !== query.from.id) {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Этот заказ принадлежит другому пользователю.",
                        show_alert: true
                    }
                );

                return;
            }

            if (order.status !== "pending") {

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Этот заказ уже обработан.",
                        show_alert: true
                    }
                );

                return;
            }

            await bot.answerCallbackQuery(
                query.id
            );

            await bot.sendMessage(

                chatId,

                `📷 Отправьте сюда скриншот или файл чека.\n\n` +

                `🧾 Заказ: \`${orderId}\`\n` +

                `💰 Сумма: ${order.amount} ₽\n\n` +

                `После получения чека администратор проверит оплату.`,

                {
                    parse_mode: "Markdown"
                }
            );

            return;
        }


        // =============================================
        // ADMIN CONFIRM
        // =============================================

        if (data.startsWith("admin_confirm_")) {

            if (query.from.id !== ADMIN_ID) {

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
                data.substring(
                    "admin_confirm_".length
                );

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
                                : "Ошибка заказа",

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

            const until =
                result.until.toLocaleString(
                    "ru-RU"
                );

            // Меняем кнопки у сообщения админа
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

            } catch (e) {
                console.log(
                    "Не удалось убрать кнопки:",
                    e.message
                );
            }

            // Сообщение админу
            await bot.sendMessage(

                ADMIN_ID,

                `✅ Заказ \`${orderId}\` подтверждён.\n\n` +

                `👤 Пользователь: ${result.userId}\n` +

                `📅 Подписка до: ${until}`,

                {
                    parse_mode: "Markdown"
                }
            );

            // Сообщение пользователю
            await bot.sendMessage(

                result.userId,

                `🎉 Оплата подтверждена!\n\n` +

                `📅 Подписка активна до:\n${until}\n\n` +

                `🔑 Ваш ключ доступа:\n` +

                `\`${result.userId}\`\n\n` +

                `Скопируйте ключ и введите его в приложении J.A.R.V.I.S.`,

                {
                    parse_mode: "Markdown",
                    ...mainMenu()
                }
            );

            return;
        }


        // =============================================
        // ADMIN REJECT
        // =============================================

        if (data.startsWith("admin_reject_")) {

            if (query.from.id !== ADMIN_ID) {

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
                data.substring(
                    "admin_reject_".length
                );

            const result =
                rejectOrder(orderId);

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

            } catch (e) {
                console.log(
                    "Не удалось убрать кнопки:",
                    e.message
                );
            }

            await bot.sendMessage(

                ADMIN_ID,

                `❌ Заказ \`${orderId}\` отклонён.`,

                {
                    parse_mode: "Markdown"
                }
            );

            await bot.sendMessage(

                result.userId,

                `❌ Оплата по заказу \`${orderId}\` не подтверждена.\n\n` +

                `Если произошла ошибка, свяжитесь с администратором.`,

                {
                    parse_mode: "Markdown",
                    ...mainMenu()
                }
            );

            return;
        }

    } catch (error) {

        console.error(
            "Ошибка callback:",
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


// =====================================================
// ПОЛУЧЕНИЕ ФОТО ЧЕКА
// =====================================================

bot.on("photo", async (msg) => {

    try {

        const order =
            getLastPendingOrder(
                msg.from.id
            );

        if (!order) {

            await bot.sendMessage(
                msg.chat.id,

                "❌ У вас нет ожидающего заказа.\n\n" +
                "Сначала выберите тариф через «🛒 Купить»."
            );

            return;
        }

        const username =
            msg.from.username
                ? `@${msg.from.username}`
                : "нет";

        // Пользователю
        await bot.sendMessage(

            msg.chat.id,

            `✅ Чек получен.\n\n` +

            `🧾 Заказ: \`${order.order_id}\`\n\n` +

            `Ожидайте проверки администратора.`,

            {
                parse_mode: "Markdown"
            }
        );

        // Админу
        await bot.sendMessage(

            ADMIN_ID,

            `💰 НОВЫЙ ПЛАТЁЖ\n\n` +

            `🧾 Заказ: \`${order.order_id}\`\n` +

            `👤 User ID: ${msg.from.id}\n` +

            `👤 Username: ${username}\n` +

            `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +

            `💰 Сумма: ${order.amount} ₽`,

            {
                parse_mode: "Markdown"
            }
        );

        // Пересылаем оригинальный чек
        await bot.forwardMessage(

            ADMIN_ID,

            msg.chat.id,

            msg.message_id
        );

        // Кнопки под отдельным сообщением
        await bot.sendMessage(

            ADMIN_ID,

            `Что сделать с заказом \`${order.order_id}\`?`,

            {
                parse_mode: "Markdown",
                ...adminPaymentKeyboard(
                    order.order_id
                )
            }
        );

    } catch (error) {

        console.error(
            "Ошибка обработки фото:",
            error
        );

        await bot.sendMessage(
            msg.chat.id,
            "❌ Не удалось обработать чек. Попробуйте ещё раз."
        );
    }
});


// =====================================================
// ПОЛУЧЕНИЕ ФАЙЛА ЧЕКА
// =====================================================

bot.on("document", async (msg) => {

    try {

        const order =
            getLastPendingOrder(
                msg.from.id
            );

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

            `✅ Чек получен.\n\n` +

            `🧾 Заказ: \`${order.order_id}\`\n\n` +

            `Ожидайте проверки администратора.`,

            {
                parse_mode: "Markdown"
            }
        );

        await bot.sendMessage(

            ADMIN_ID,

            `💰 НОВЫЙ ПЛАТЁЖ\n\n` +

            `🧾 Заказ: \`${order.order_id}\`\n` +

            `👤 User ID: ${msg.from.id}\n` +

            `👤 Username: ${username}\n` +

            `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +

            `💰 Сумма: ${order.amount} ₽`,

            {
                parse_mode: "Markdown"
            }
        );

        await bot.forwardMessage(

            ADMIN_ID,

            msg.chat.id,
            msg.message_id
        );

        await bot.sendMessage(

            ADMIN_ID,

            `Что сделать с заказом \`${order.order_id}\`?`,

            {
                parse_mode: "Markdown",
                ...adminPaymentKeyboard(
                    order.order_id
                )
            }
        );

    } catch (error) {

        console.error(
            "Ошибка обработки документа:",
            error
        );

        await bot.sendMessage(
            msg.chat.id,
            "❌ Не удалось обработать чек."
        );
    }
});


// =====================================================
// ЗАПУСК БД
// =====================================================

initDb();

console.log("=================================");
console.log("🤖 J.A.R.V.I.S BOT ЗАПУЩЕН");
console.log(`👑 ADMIN_ID: ${ADMIN_ID}`);
console.log(`💾 DATABASE: ${DB_FILE}`);
console.log("=================================");
