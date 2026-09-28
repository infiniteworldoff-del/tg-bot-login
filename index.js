// ============================================================
// J.A.R.V.I.S — TELEGRAM SUBSCRIPTION BOT
// ============================================================

const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// ==================== НАСТРОЙКИ ====================

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

const ADMIN_ID_1 = 8723208814;
const ADMIN_ID_2 = 8882462981;

const ADMIN_IDS = [
    ADMIN_ID_1,
    ADMIN_ID_2
];

const CARD_NUMBER =
    process.env.CARD_NUMBER || "2200 1536 2364 5513";

const CARD_HOLDER =
    process.env.CARD_HOLDER || "Получатель: Алексей М.";

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

    for (const adminId of ADMIN_IDS) {
        db.prepare(`
            INSERT OR IGNORE INTO admins
            (user_id, online, offline_until)
            VALUES (?, 1, NULL)
        `).run(adminId);
    }
}

// ==================== АДМИН ====================

function isAdmin(userId) {
    return ADMIN_IDS.includes(Number(userId));
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

    if (row.online === 0 && row.offline_until) {
        const until = new Date(row.offline_until);

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

function setAdminOnline(userId) {
    db.prepare(`
        UPDATE admins
        SET online = 1,
            offline_until = NULL
        WHERE user_id = ?
    `).run(userId);
}

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

function isAnyAdminOnline() {
    for (const adminId of ADMIN_IDS) {
        if (getAdminStatus(adminId).online) {
            return true;
        }
    }

    return false;
}

function getOnlineAdminsCount() {
    let count = 0;

    for (const adminId of ADMIN_IDS) {
        if (getAdminStatus(adminId).online) {
            count++;
        }
    }

    return count;
}

// ==================== СТАТУС ДЛЯ ПОЛЬЗОВАТЕЛЯ ====================

function getAdminStatusText() {
    if (isAnyAdminOnline()) {
        return "🟢 Администратор в онлайне";
    }

    return "🔴 Администратор сейчас не может одобрить заявку.\nПожалуйста, подождите.";
}

// ==================== ГЛАВНОЕ МЕНЮ ====================

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
                    },
                    {
                        text: "🛠 Тех.поддержка"
                    }
                ]
            ],
            resize_keyboard: true,
            is_persistent: true
        }
    };
}

// ==================== ОТПРАВКА ГЛАВНОГО МЕНЮ ====================

async function sendMainMenu(chatId, text) {
    await bot.sendMessage(
        chatId,
        text + "\n\n" + getAdminStatusText(),
        mainMenu()
    );
}

// ==================== ПАРСЕР ВРЕМЕНИ ====================

function parseOfflineTime(text) {
    const value = text.toLowerCase().trim();

    const regex = /(\d+)\s*(d|h|m|s)/g;

    let match;
    let totalSeconds = 0;
    let found = false;

    while ((match = regex.exec(value)) !== null) {
        found = true;

        const number = Number(match[1]);
        const unit = match[2];

        if (unit === "d") {
            totalSeconds += number * 24 * 60 * 60;
        }

        if (unit === "h") {
            totalSeconds += number * 60 * 60;
        }

        if (unit === "m") {
            totalSeconds += number * 60;
        }

        if (unit === "s") {
            totalSeconds += number;
        }
    }

    const cleaned = value
        .replace(/(\d+)\s*(d|h|m|s)/g, "")
        .trim();

    if (!found || cleaned !== "") {
        return null;
    }

    if (totalSeconds < 1) {
        return null;
    }

    const maxSeconds = 15 * 24 * 60 * 60;

    if (totalSeconds > maxSeconds) {
        return "MAX";
    }

    return totalSeconds;
}

// ==================== ФОРМАТ ВРЕМЕНИ ====================

function formatDuration(seconds) {
    let result = [];

    let days = Math.floor(seconds / 86400);
    seconds %= 86400;

    let hours = Math.floor(seconds / 3600);
    seconds %= 3600;

    let minutes = Math.floor(seconds / 60);
    seconds %= 60;

    if (days) result.push(`${days}д`);
    if (hours) result.push(`${hours}ч`);
    if (minutes) result.push(`${minutes}мин`);
    if (seconds) result.push(`${seconds}сек`);

    return result.join(" ");
}

// ==================== СОСТОЯНИЯ ====================

const adminWaitingTime = new Set();
const userStates = new Map();

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

    const newUntil = new Date(
        start.getTime() +
        days * 24 * 60 * 60 * 1000
    );

    db.prepare
