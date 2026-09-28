// ============================================================
// J.A.R.V.I.S — TELEGRAM SUBSCRIPTION BOT
// ============================================================

// ==================== ИМПОРТЫ ====================

const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// ==================== НАСТРОЙКИ ====================

// Токен берём из Railway Variables
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

// Два администратора
const ADMIN_ID_1 = 8723208814;
const ADMIN_ID_2 = 8882462981;

const ADMIN_IDS = [
    ADMIN_ID_1,
    ADMIN_ID_2
];

// Реквизиты
const CARD_NUMBER =
    process.env.CARD_NUMBER || "2200 1536 2364 5513";

const CARD_HOLDER =
    process.env.CARD_HOLDER || "Получатель: Алексей М.";

// Техподдержка
const SUPPORT_USERNAME = "@JARBIS_help";

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

// ==================== ПРОВЕРКА ТОКЕНА ====================

if (!BOT_TOKEN) {
    console.error("❌ Ошибка: TELEGRAM_TOKEN не установлен!");
    process.exit(1);
}

// ==================== БОТ ====================

const bot = new TelegramBot(BOT_TOKEN, {
    polling: true
});

// ==================== DATABASE ====================

// Railway Volume
// Если /data существует — используем его.
// Иначе используем локальный файл.

const DB_FILE = fs.existsSync("/data")
    ? "/data/subscriptions.db"
    : "./subscriptions.db";

const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");

// ==================== СОЗДАНИЕ ТАБЛИЦ ====================

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
            paid_at TEXT,
            name TEXT,
            email TEXT
        );

        CREATE TABLE IF NOT EXISTS admins (
            user_id INTEGER PRIMARY KEY,
            online INTEGER DEFAULT 1,
            offline_until TEXT
        );
    `);

    // Добавляем админов
    for (const adminId of ADMIN_IDS) {

        db.prepare(`
            INSERT OR IGNORE INTO admins
            (user_id, online, offline_until)
            VALUES (?, 1, NULL)
        `).run(adminId);
    }
}

// ==================== ПРОВЕРКА АДМИНА ====================

function isAdmin(userId) {

    return ADMIN_IDS.includes(
        Number(userId)
    );
}

// ==================== СТАТУС АДМИНА ====================

function getAdminStatus(userId) {

    const row = db.prepare(`
        SELECT *
        FROM admins
        WHERE user_id = ?
    `).get(userId);

    if (!row) {
        return {
            online: false
        };
    }

    // Проверяем окончание временного отключения

    if (
        row.online === 0 &&
        row.offline_until
    ) {

        const until =
            new Date(row.offline_until);

        if (until <= new Date()) {

            db.prepare(`
                UPDATE admins
                SET online = 1,
                    offline_until = NULL
                WHERE user_id = ?
            `).run(userId);

            return {
                online: true
            };
        }
    }

    return {
        online: row.online === 1,
        offlineUntil: row.offline_until
    };
}

// ==================== АДМИН ОНЛАЙН ====================

function setAdminOnline(userId) {

    db.prepare(`
        UPDATE admins
        SET online = 1,
            offline_until = NULL
        WHERE user_id = ?
    `).run(userId);
}

// ==================== АДМИН ОФФЛАЙН ====================

function setAdminOffline(userId, until) {

    db.prepare(`
        UPDATE admins
        SET online = 0,
            offline_until = ?
        WHERE user_id = ?
    `).run(
        until.toISOString(),
        userId
    );
}

// ==================== ЕСТЬ ЛИ ОНЛАЙН АДМИН ====================

function isAnyAdminOnline() {

    for (const adminId of ADMIN_IDS) {

        if (
            getAdminStatus(adminId).online
        ) {
            return true;
        }
    }

    return false;
}

// ==================== КОЛИЧЕСТВО ОНЛАЙН ====================

function getOnlineAdminsCount() {

    let count = 0;

    for (const adminId of ADMIN_IDS) {

        if (
            getAdminStatus(adminId).online
        ) {
            count++;
        }
    }

    return count;
}

// ==================== ПАРСЕР ВРЕМЕНИ ====================

// Поддерживает:
//
// 5s
// 5m
// 5h
// 5d
//
// а также:
//
// 2d 5h
// 2d 5h 30m
// 1d 2h 10m 20s

function parseOfflineTime(text) {

    const value =
        text
            .toLowerCase()
            .trim();

    const regex =
        /(\d+)\s*(d|h|m|s)/g;

    let match;

    let totalSeconds = 0;

    let found = false;

    while (
        (match = regex.exec(value)) !== null
    ) {

        found = true;

        const number =
            Number(match[1]);

        const unit =
            match[2];

        if (unit === "d") {
            totalSeconds +=
                number * 24 * 60 * 60;
        }

        if (unit === "h") {
            totalSeconds +=
                number * 60 * 60;
        }

        if (unit === "m") {
            totalSeconds +=
                number * 60;
        }

        if (unit === "s") {
            totalSeconds +=
                number;
        }
    }

    const cleaned =
        value.replace(
            /(\d+)\s*(d|h|m|s)/g,
            ""
        ).trim();

    if (!found || cleaned !== "") {
        return null;
    }

    if (totalSeconds < 1) {
        return null;
    }

    // Максимум 15 дней

    const maxSeconds =
        15 * 24 * 60 * 60;

    if (totalSeconds > maxSeconds) {
        return "MAX";
    }

    return totalSeconds;
}

// ==================== ФОРМАТ ВРЕМЕНИ ====================

function formatDuration(seconds) {

    let result = [];

    let days =
        Math.floor(seconds / 86400);

    seconds %= 86400;

    let hours =
        Math.floor(seconds / 3600);

    seconds %= 3600;

    let minutes =
        Math.floor(seconds / 60);

    seconds %= 60;

    if (days) {
        result.push(`${days}д`);
    }

    if (hours) {
        result.push(`${hours}ч`);
    }

    if (minutes) {
        result.push(`${minutes}мин`);
    }

    if (seconds) {
        result.push(`${seconds}сек`);
    }

    return result.join(" ");
}

// ==================== СОСТОЯНИЕ АДМИНОВ ====================

const adminWaitingTime = new Set();

// ==================== СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЕЙ ====================

const userStates = new Map();

// ==================== ПОЛЬЗОВАТЕЛИ ====================

function upsertUser(
    userId,
    username = null
) {

    db.prepare(`
        INSERT OR IGNORE INTO users
        (user_id, username)
        VALUES (?, ?)
    `).run(
        userId,
        username
    );

    if (username) {

        db.prepare(`
            UPDATE users
            SET username = ?
            WHERE user_id = ?
        `).run(
            username,
            userId
        );
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

    const user =
        getUser(userId);

    if (
        !user ||
        !user.sub_until
    ) {
        return false;
    }

    return (
        new Date(user.sub_until) >
        new Date()
    );
}

function setSubscription(
    userId,
    days
) {

    const user =
        getUser(userId);

    const now =
        new Date();

    let start = now;

    if (
        user &&
        user.sub_until
    ) {

        const current =
            new Date(
                user.sub_until
            );

        if (current > now) {
            start = current;
        }
    }

    const newUntil =
        new Date(
            start.getTime() +
            days *
            24 *
            60 *
            60 *
            1000
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

// ==================== СОЗДАНИЕ ЗАКАЗА ====================

function createOrder(
    userId,
    tariffKey,
    name,
    email
) {

    const tariff =
        TARIFFS[tariffKey];

    if (!tariff) {
        throw new Error(
            "Тариф не найден"
        );
    }

    const orderId =
        crypto
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
            created_at,
            name,
            email
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        orderId,
        userId,
        tariffKey,
        tariff.price,
        "pending",
        new Date().toISOString(),
        name,
        email
    );

    return orderId;
}

// ==================== ПОЛУЧИТЬ ЗАКАЗ ====================

function getOrder(orderId) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE order_id = ?
    `).get(orderId);
}

// ==================== ПОСЛЕДНИЙ ОЖИДАЮЩИЙ ЗАКАЗ ====================

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

// ==================== ПОДТВЕРДИТЬ ЗАКАЗ ====================

function confirmOrder(orderId) {

    const order =
        getOrder(orderId);

    if (!order) {
        return {
            success: false,
            reason: "not_found"
        };
    }

    if (
        order.status !== "pending"
    ) {
        return {
            success: false,
            reason: "already_processed"
        };
    }

    const tariff =
        TARIFFS[order.tariff];

    if (!tariff) {
        return {
            success: false,
            reason: "tariff_not_found"
        };
    }

    const until =
        setSubscription(
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
        SET total_paid =
            total_paid + ?
        WHERE user_id = ?
    `).run(
        order.amount,
        order.user_id
    );

    return {
        success: true,
        userId: order.user_id,
        until: until,
        order: order
    };
}

// ==================== ОТКЛОНИТЬ ====================

function rejectOrder(orderId) {

    const order =
        getOrder(orderId);

    if (!order) {
        return {
            success: false,
            reason: "not_found"
        };
    }

    if (
        order.status !== "pending"
    ) {
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
        userId: order.user_id,
        order: order
    };
}

// ==================== ГЛАВНОЕ МЕНЮ ====================

function mainMenu() {

    const online =
        isAnyAdminOnline();

    const status =
        online
            ? "🟢 Администратор в онлайне"
            : "🔴 Администратор сейчас не может одобрить заявку.\nПожалуйста, подождите.";

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
                    },
                    {
                        text: "🛠 Тех.поддержка"
                    }
                ]

            ],

            resize_keyboard: true,

            is_persistent: true
        },

        caption: status
    };
}

// ==================== МЕНЮ ПОКУПКИ ====================

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

// ==================== МЕНЮ АДМИНА ====================

function adminMenu() {

    return {

        reply_markup: {

            inline_keyboard: [

                [
                    {
                        text: "🟢 Я онлайн",
                        callback_data: "admin_online"
                    }
                ],

                [
                    {
                        text: "🔴 Я не онлайн",
                        callback_data: "admin_offline"
                    }
                ]

            ]
        }
    };
}

// ==================== КНОПКИ ЗАКАЗА ====================

function adminOrderButtons(orderId) {

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

// ============================================================
// START
// ============================================================

bot.onText(
    /^\/start$/,
    async (msg) => {

        try {

            upsertUser(
                msg.from.id,
                msg.from.username || null
            );

            const online =
                isAnyAdminOnline();

            const status =
                online
                    ? "🟢 Администратор в онлайне"
                    : "🔴 Администратор сейчас не может одобрить заявку.\nПожалуйста, подождите.";

            await bot.sendMessage(

                msg.chat.id,

                "👋 Добро пожаловать в J.A.R.V.I.S!\n\n" +

                "Это бот для покупки подписки.\n\n" +

                "Выберите действие.\n\n" +

                status,

                mainMenu()
            );

            // Показываем админскую панель
            // только двум указанным ID

            if (
                isAdmin(msg.from.id)
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "👨‍💼 Панель администратора\n\n" +

                    `🟢 Администраторов онлайн: ${getOnlineAdminsCount()}/2`,

                    adminMenu()
                );
            }

        } catch (error) {

            console.error(
                "START ERROR:",
                error
            );
        }
    }
);

// ============================================================
// /id
// ============================================================

bot.onText(
    /^\/id$/,
    async (msg) => {

        await bot.sendMessage(

            msg.chat.id,

            `🆔 Ваш Telegram ID:\n\n${msg.from.id}`
        );
    }
);

// ============================================================
// /admin
// ============================================================

bot.onText(
    /^\/admin$/,
    async (msg) => {

        if (
            !isAdmin(msg.from.id)
        ) {
            return;
        }

        await bot.sendMessage(

            msg.chat.id,

            "👨‍💼 Панель администратора\n\n" +

            `🟢 Администраторов онлайн: ${getOnlineAdminsCount()}/2`,

            adminMenu()
        );
    }
);

// ============================================================
// ОБРАБОТКА СООБЩЕНИЙ
// ============================================================

bot.on(
    "message",
    async (msg) => {

        try {

            if (!msg.text) {
                return;
            }

            const text =
                msg.text.trim();

            // --------------------------------------------
            // Ввод времени администратором
            // --------------------------------------------

            if (
                isAdmin(msg.from.id) &&
                adminWaitingTime.has(msg.from.id)
            ) {

                const seconds =
                    parseOfflineTime(text);

                if (seconds === "MAX") {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Максимум — 15 дней.\n\n" +
                        "Примеры:\n" +
                        "5h\n" +
                        "5m\n" +
                        "5s\n" +
                        "5d\n" +
                        "2d 5h 30m"
                    );

                    return;
                }

                if (seconds === null) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Неверный формат.\n\n" +

                        "Используйте:\n" +
                        "5h — 5 часов\n" +
                        "5m — 5 минут\n" +
                        "5s — 5 секунд\n" +
                        "5d — 5 дней\n\n" +

                        "Можно:\n" +
                        "2d 5h 30m"
                    );

                    return;
                }

                const until =
                    new Date(
                        Date.now() +
                        seconds * 1000
                    );

                setAdminOffline(
                    msg.from.id,
                    until
                );

                adminWaitingTime.delete(
                    msg.from.id
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "🔴 Вы теперь не онлайн.\n\n" +

                    `⏱ Время: ${formatDuration(seconds)}\n` +

                    `🕐 До: ${until.toLocaleString("ru-RU")}\n\n` +

                    "Когда вернётесь, нажмите:\n" +
                    "🟢 Я онлайн",

                    adminMenu()
                );

                return;
            }

            // --------------------------------------------
            // Кнопка "Я онлайн"
            // --------------------------------------------

            if (
                isAdmin(msg.from.id) &&
                text === "🟢 Я онлайн"
            ) {

                setAdminOnline(
                    msg.from.id
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "🟢 Вы снова онлайн!\n\n" +
                    "Пользователи видят:\n" +
                    "🟢 Администратор в онлайне",

                    adminMenu()
                );

                return;
            }

            // --------------------------------------------
            // Кнопка "Я не онлайн"
            // --------------------------------------------

            if (
                isAdmin(msg.from.id) &&
                text === "🔴 Я не онлайн"
            ) {

                adminWaitingTime.add(
                    msg.from.id
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "⏱ На какое время вы будете не онлайн?\n\n" +

                    "Напишите:\n\n" +

                    "5h — 5 часов\n" +
                    "5m — 5 минут\n" +
                    "5s — 5 секунд\n" +
                    "5d — 5 дней\n\n" +

                    "Можно комбинировать:\n" +
                    "2d 5h 30m\n\n" +

                    "⚠️ Максимум — 15 дней."
                );

                return;
            }

            // --------------------------------------------
            // Техподдержка
            // --------------------------------------------

            if (
                text === "🛠 Тех.поддержка"
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "🛠 Тех.поддержка:\n" +
                    "@JARBIS_help"
                );

                return;
            }

            // --------------------------------------------
            // Кнопка Войти
            // --------------------------------------------

            if (
                text === "🔑 Войти"
            ) {

                if (
                    !isSubActive(
                        msg.from.id
                    )
                ) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ У вас нет активной подписки.\n\n" +
                        "Нажмите «🛒 Купить», чтобы оформить доступ.",

                        mainMenu()
                    );

                    return;
                }

                const user =
                    getUser(msg.from.id);

                const until =
                    new Date(
                        user.sub_until
                    ).toLocaleString(
                        "ru-RU"
                    );

                await bot.sendMessage(

                    msg.chat.id,

                    "✅ Подписка активна!\n\n" +

                    `📅 До: ${until}\n\n` +

                    "🔑 Ваш ключ:\n\n" +

                    `\`${msg.from.id}\`\n\n` +

                    "Введите этот ключ в приложении J.A.R.V.I.S.",

                    {
                        parse_mode: "Markdown"
                    }
                );

                return;
            }

            // --------------------------------------------
            // Купить
            // --------------------------------------------

            if (
                text === "🛒 Купить"
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "🛒 Выберите тариф:",

                    buyMenu()
                );

                return;
            }

            // --------------------------------------------
            // Помощь
            // --------------------------------------------

            if (
                text === "ℹ️ Помощь"
            ) {

                const online =
                    isAnyAdminOnline();

                const status =
                    online
                        ? "🟢 Администратор в онлайне"
                        : "🔴 Администратор сейчас не может одобрить заявку.\nПожалуйста, подождите.";

                await bot.sendMessage(

                    msg.chat.id,

                    "ℹ️ Помощь\n\n" +

                    "🔑 «Войти» — получить ключ.\n" +
                    "🛒 «Купить» — приобрести подписку.\n" +
                    "🛠 «Тех.поддержка» — связаться с поддержкой.\n\n" +

                    `💳 Карта: ${CARD_NUMBER}\n` +
                    `${CARD_HOLDER}\n\n` +

                    status,

                    mainMenu()
                );

                return;
            }

        } catch (error) {

            console.error(
                "MESSAGE ERROR:",
                error
            );
        }
    }
);

// ============================================================
// CALLBACK QUERY
// ============================================================

bot.on(
    "callback_query",
    async (query) => {

        try {

            const data =
                query.data;

            const chatId =
                query.message.chat.id;

            const messageId =
                query.message.message_id;

            // =================================================
            // ADMIN ONLINE
            // =================================================

            if (
                data === "admin_online"
            ) {

                if (
                    !isAdmin(query.from.id)
                ) {

                    await bot.answerCallbackQuery(
                        query.id,
                        {
                            text: "Нет доступа",
                            show_alert: true
                        }
                    );

                    return;
                }

                setAdminOnline(
                    query.from.id
                );

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text: "Вы онлайн 🟢"
                    }
                );

                await bot.sendMessage(

                    chatId,

                    "🟢 Вы онлайн!\n\n" +

                    "Пользователи видят:\n" +
                    "🟢 Администратор в онлайне",

                    adminMenu()
                );

                return;
            }

            // =================================================
            // ADMIN OFFLINE
            // =================================================

            if (
                data === "admin_offline"
            ) {

                if (
                    !isAdmin(query.from.id)
                ) {

                    await bot.answerCallbackQuery(
                        query.id,
                        {
                            text: "Нет доступа",
                            show_alert: true
                        }
                    );

                    return;
                }

                adminWaitingTime.add(
                    query.from.id
                );

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "⏱ На какое время вы будете не онлайн?\n\n" +

                    "5h\n" +
                    "5m\n" +
                    "5s\n" +
                    "5d\n\n" +

                    "Можно:\n" +
                    "2d 5h 30m\n\n" +

                    "⚠️ Максимум — 15 дней."
                );

                return;
            }

            // =================================================
            // BACK
            // =================================================

            if (
                data === "back"
            ) {

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "📋 Главное меню:",

                    mainMenu()
                );

                return;
            }

            // =================================================
            // BUY
            // =================================================

            if (
                data.startsWith("buy_")
            ) {

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

                await bot.answerCallbackQuery(
                    query.id
                );

                // Сохраняем выбранный тариф

                userStates.set(

                    query.from.id,

                    {
                        step: "name",
                        tariffKey: tariffKey
                    }
                );

                await bot.sendMessage(

                    chatId,

                    `📦 Вы выбрали: ${tariff.name}\n` +
                    `💰 Цена: ${tariff.price} ₽\n\n` +

                    "👤 Введите ваше имя:"
                );

                return;
            }

            // =================================================
            // CONFIRM
            // =================================================

            if (
                data.startsWith("confirm_")
            ) {

                if (
                    !isAdmin(query.from.id)
                ) {

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
                    result.until.toLocaleString(
                        "ru-RU"
                    );

                // Сообщаем пользователю

                await bot.sendMessage(

                    result.userId,

                    "🎉 Оплата подтверждена!\n\n" +

                    `👤 Имя: ${result.order.name}\n` +
                    `📧 Email: ${result.order.email}\n\n` +

                    `📅 Подписка до:\n${until}\n\n` +

                    "🔑 Ваш ключ:\n" +

                    `\`${result.userId}\``,

                    {
                        parse_mode: "Markdown"
                    }
                );

                return;
            }

            // =================================================
            // REJECT
            // =================================================

            if (
                data.startsWith("reject_")
            ) {

                if (
                    !isAdmin(query.from.id)
                ) {

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

                    "❌ Ваша оплата не была подтверждена.\n\n" +
                    "Свяжитесь с администратором."
                );

                return;
            }

            // =================================================
            // PAID
            // =================================================

            if (
                data.startsWith("paid_")
            ) {

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

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "📷 Отправьте чек оплаты.\n\n" +

                    `🧾 Заказ: \`${orderId}\`\n` +

                    `👤 Имя: ${order.name}\n` +

                    `📧 Email: ${order.email}\n\n` +

                    `📦 Тариф: ${TARIFFS[order.tariff].name}`,

                    {
                        parse_mode: "Markdown"
                    }
                );

                return;
            }

            await bot.answerCallbackQuery(
                query.id
            );

        } catch (error) {

            console.error(
                "CALLBACK ERROR:",
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
    }
);

// ============================================================
// ИМЯ + EMAIL
// ============================================================

bot.on(
    "message",
    async (msg) => {

        try {

            if (!msg.text) {
                return;
            }

            const state =
                userStates.get(
                    msg.from.id
                );

            if (!state) {
                return;
            }

            // ============================
            // ИМЯ
            // ============================

            if (
                state.step === "name"
            ) {

                const name =
                    msg.text.trim();

                if (
                    name.length < 2
                ) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Имя слишком короткое.\n\n" +
                        "Введите ваше имя:"
                    );

                    return;
                }

                state.name =
                    name;

                state.step =
                    "email";

                userStates.set(
                    msg.from.id,
                    state
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "📧 Теперь введите ваш email:\n\n" +
                    "Например:\n" +
                    "example@gmail.com"
                );

                return;
            }

            // ============================
            // EMAIL
            // ============================

            if (
                state.step === "email"
            ) {

                const email =
                    msg.text.trim();

                const emailRegex =
                    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (
                    !emailRegex.test(email)
                ) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Неверный email.\n\n" +
                        "Например:\n" +
                        "example@gmail.com"
                    );

                    return;
                }

                const tariff =
                    TARIFFS[
                        state.tariffKey
                    ];

                const orderId =
                    createOrder(

                        msg.from.id,

                        state.tariffKey,

                        state.name,

                        email
                    );

                userStates.delete(
                    msg.from.id
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "🧾 ЗАКАЗ СОЗДАН\n\n" +

                    `№ Заказа: \`${orderId}\`\n\n` +

                    `👤 Имя: ${state.name}\n` +

                    `📧 Email: ${email}\n\n` +

                    `📦 Тариф: ${tariff.name}\n` +

                    `💰 Сумма: ${tariff.price} ₽\n\n` +

                    "💳 Реквизиты для оплаты:\n\n" +

                    `Карта: \`${CARD_NUMBER}\`\n` +

                    `${CARD_HOLDER}\n\n` +

                    "⚠️ В комментарии к переводу обязательно укажите номер заказа:\n\n" +

                    `\`${orderId}\`\n\n` +

                    "После оплаты нажмите кнопку ниже и отправьте чек.",

                    {

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
                                        callback_data:
                                            "back"
                                    }
                                ]

                            ]
                        }
                    }
                );

                return;
            }

        } catch (error) {

            console.error(
                "NAME/EMAIL ERROR:",
                error
            );
        }
    }
);

// ============================================================
// ПОЛУЧЕНИЕ ФОТО ЧЕКА
// ============================================================

bot.on(
    "photo",
    async (msg) => {

        try {

            const order =
                getPendingOrder(
                    msg.from.id
                );

            if (!order) {

                await bot.sendMessage(

                    msg.chat.id,

                    "❌ У вас нет ожидающего заказа."
                );

                return;
            }

            await bot.sendMessage(

                msg.chat.id,

                "✅ Чек получен!\n\n" +

                `🧾 Заказ: ${order.order_id}\n\n` +

                "Ожидайте проверки администратора."
            );

            const username =
                msg.from.username
                    ? `@${msg.from.username}`
                    : "нет";

            const adminText =

                "📩 НОВАЯ ЗАЯВКА\n\n" +

                `🧾 Заказ: \`${order.order_id}\`\n\n` +

                `👤 Имя: ${order.name}\n` +

                `📧 Email: ${order.email}\n` +

                `👤 User ID: ${order.user_id}\n` +

                `👤 Username: ${username}\n\n` +

                `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +

                `💰 Сумма: ${order.amount} ₽`;

            // Отправляем обоим администраторам

            for (
                const adminId of ADMIN_IDS
            ) {

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

                        `Выберите действие с заказом \`${order.order_id}\`:`,
                        {
                            parse_mode: "Markdown",
                            ...adminOrderButtons(
                                order.order_id
                            )
                        }
                    );

                } catch (error) {

                    console.error(
                        `Ошибка отправки админу ${adminId}:`,
                        error.message
                    );
                }
            }

        } catch (error) {

            console.error(
                "PHOTO ERROR:",
                error
            );
        }
    }
);

// ============================================================
// ПОЛУЧЕНИЕ ЧЕКА ДОКУМЕНТОМ
// ============================================================

bot.on(
    "document",
    async (msg) => {

        try {

            const order =
                getPendingOrder(
                    msg.from.id
                );

            if (!order) {

                await bot.sendMessage(

                    msg.chat.id,

                    "❌ У вас нет ожидающего заказа."
                );

                return;
            }

            await bot.sendMessage(

                msg.chat.id,

                "✅ Чек получен!\n\n" +

                `🧾 Заказ: ${order.order_id}\n\n` +

                "Ожидайте проверки администратора."
            );

            const username =
                msg.from.username
                    ? `@${msg.from.username}`
                    : "нет";

            const adminText =

                "📩 НОВАЯ ЗАЯВКА\n\n" +

                `🧾 Заказ: \`${order.order_id}\`\n\n` +

                `👤 Имя: ${order.name}\n` +

                `📧 Email: ${order.email}\n` +

                `👤 User ID: ${order.user_id}\n` +

                `👤 Username: ${username}\n\n` +

                `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +

                `💰 Сумма: ${order.amount} ₽`;

            for (
                const adminId of ADMIN_IDS
            ) {

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

                        `Выберите действие с заказом \`${order.order_id}\`:`,
                        {
                            parse_mode: "Markdown",
                            ...adminOrderButtons(
                                order.order_id
                            )
                        }
                    );

                } catch (error) {

                    console.error(
                        `Ошибка отправки админу ${adminId}:`,
                        error.message
                    );
                }
            }

        } catch (error) {

            console.error(
                "DOCUMENT ERROR:",
                error
            );
        }
    }
);

// ============================================================
// ЗАПУСК
// ============================================================

initDb();

console.log(
    "=========================================="
);

console.log(
    "🤖 J.A.R.V.I.S BOT ЗАПУЩЕН"
);

console.log(
    "👑 ADMIN 1:",
    ADMIN_ID_1
);

console.log(
    "👑 ADMIN 2:",
    ADMIN_ID_2
);

console.log(
    "🛠 SUPPORT:",
    SUPPORT_USERNAME
);

console.log(
    "💾 DATABASE:",
    DB_FILE
);

console.log(
    "🟢 ONLINE ADMINS:",
    getOnlineAdminsCount()
);

console.log(
    "=========================================="
);
