// db.js — połączenie z PostgreSQL i funkcje dostępu do danych.
const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

async function query(text, params) {
    return pool.query(text, params);
}

// ---------- Konta ----------

async function getOrCreateAccount(email) {
    const key = email.toLowerCase();
    const existing = await query("SELECT * FROM accounts WHERE email = $1", [key]);
    if (existing.rows.length > 0) return existing.rows[0];

    const inserted = await query(
        `INSERT INTO accounts (email, trial_starts_at) VALUES ($1, now()) RETURNING *`,
        [key]
    );
    return inserted.rows[0];
}

async function updateAccount(email, patch) {
    const key = email.toLowerCase();
    const fields = [];
    const values = [];
    let i = 1;
    for (const [col, val] of Object.entries(patch)) {
        fields.push(`${col} = $${i}`);
        values.push(val);
        i++;
    }
    fields.push(`updated_at = now()`);
    values.push(key);
    const sql = `UPDATE accounts SET ${fields.join(", ")} WHERE email = $${i} RETURNING *`;
    const result = await query(sql, values);
    return result.rows[0];
}

async function findAccountBySubscriptionId(subscriptionId) {
    const result = await query("SELECT * FROM accounts WHERE subscription_id = $1", [subscriptionId]);
    return result.rows[0] || null;
}

async function listAccounts(limit = 200, offset = 0) {
    const result = await query(
        "SELECT * FROM accounts ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        [limit, offset]
    );
    return result.rows;
}

// ---------- Kody promocyjne ----------

async function findPromoCode(code) {
    const result = await query("SELECT * FROM promo_codes WHERE lower(code) = lower($1)", [code]);
    return result.rows[0] || null;
}

async function incrementPromoUsage(id) {
    await query("UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1", [id]);
}

async function listPromoCodes() {
    const result = await query("SELECT * FROM promo_codes ORDER BY created_at DESC");
    return result.rows;
}

async function createPromoCode({ code, days, maxUses, expiresAt }) {
    const result = await query(
        `INSERT INTO promo_codes (code, days, max_uses, expires_at) VALUES ($1, $2, $3, $4) RETURNING *`,
        [code.toUpperCase(), days, maxUses || null, expiresAt || null]
    );
    return result.rows[0];
}

async function setPromoCodeActive(id, active) {
    await query("UPDATE promo_codes SET active = $1 WHERE id = $2", [active, id]);
}

async function deletePromoCode(id) {
    await query("DELETE FROM promo_codes WHERE id = $1", [id]);
}

// ---------- Wykrycia ----------

async function insertDetection({ email, plate, label, imageBuffer, imageMime, latitude, longitude, detectedAt }) {
    const result = await query(
        `INSERT INTO detections (account_email, plate, label, image, image_mime, latitude, longitude, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, detected_at`,
        [email.toLowerCase(), plate, label || "", imageBuffer || null, imageMime || "image/jpeg", latitude || null, longitude || null, detectedAt]
    );
    return result.rows[0];
}

async function listDetections(limit = 100, offset = 0, emailFilter = null) {
    if (emailFilter) {
        const result = await query(
            `SELECT id, account_email, plate, label, latitude, longitude, detected_at,
                    (image IS NOT NULL) AS has_image
             FROM detections WHERE account_email = $1 ORDER BY detected_at DESC LIMIT $2 OFFSET $3`,
            [emailFilter.toLowerCase(), limit, offset]
        );
        return result.rows;
    }
    const result = await query(
        `SELECT id, account_email, plate, label, latitude, longitude, detected_at,
                (image IS NOT NULL) AS has_image
         FROM detections ORDER BY detected_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    return result.rows;
}

async function getDetectionImage(id) {
    const result = await query("SELECT image, image_mime FROM detections WHERE id = $1", [id]);
    return result.rows[0] || null;
}

// ---------- Flota pojazdów (centralnie zarządzana, synchronizowana do telefonów) ----------

async function listFleetVehicles(activeOnly = true) {
    const sql = activeOnly
        ? "SELECT * FROM fleet_vehicles WHERE active = TRUE ORDER BY plate ASC"
        : "SELECT * FROM fleet_vehicles ORDER BY created_at DESC";
    const result = await query(sql);
    return result.rows;
}

async function createFleetVehicle({ plate, label }) {
    const result = await query(
        `INSERT INTO fleet_vehicles (plate, label) VALUES ($1, $2)
         ON CONFLICT (upper(plate)) DO UPDATE SET label = EXCLUDED.label, active = TRUE, updated_at = now()
         RETURNING *`,
        [plate.toUpperCase(), label || ""]
    );
    return result.rows[0];
}

async function updateFleetVehicle(id, patch) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const [col, val] of Object.entries(patch)) {
        fields.push(`${col} = $${i}`);
        values.push(val);
        i++;
    }
    fields.push(`updated_at = now()`);
    values.push(id);
    const sql = `UPDATE fleet_vehicles SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`;
    const result = await query(sql, values);
    return result.rows[0];
}

async function deleteFleetVehicle(id) {
    await query("DELETE FROM fleet_vehicles WHERE id = $1", [id]);
}

// ---------- Sklep ----------

async function listShopProducts(activeOnly = true) {
    const cols = "id, title, description, price, url, sort_order, active, created_at, (image IS NOT NULL) AS has_image";
    const sql = activeOnly
        ? `SELECT ${cols} FROM shop_products WHERE active = TRUE ORDER BY sort_order ASC, id ASC`
        : `SELECT ${cols} FROM shop_products ORDER BY sort_order ASC, id ASC`;
    const result = await query(sql);
    return result.rows;
}

async function createShopProduct({ title, description, price, url, sortOrder, imageBuffer, imageMime }) {
    const result = await query(
        `INSERT INTO shop_products (title, description, price, url, sort_order, image, image_mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [title, description || "", price || "", url || "", sortOrder || 0, imageBuffer || null, imageMime || null]
    );
    return result.rows[0];
}

async function getShopProductImage(id) {
    const result = await query("SELECT image, image_mime FROM shop_products WHERE id = $1", [id]);
    return result.rows[0] || null;
}

async function updateShopProduct(id, patch) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const [col, val] of Object.entries(patch)) {
        fields.push(`${col} = $${i}`);
        values.push(val);
        i++;
    }
    values.push(id);
    const sql = `UPDATE shop_products SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`;
    const result = await query(sql, values);
    return result.rows[0];
}

async function deleteShopProduct(id) {
    await query("DELETE FROM shop_products WHERE id = $1", [id]);
}

// ---------- Kontakt ----------

async function insertContactMessage({ name, email, subject, message }) {
    await query(
        `INSERT INTO contact_messages (name, email, subject, message) VALUES ($1, $2, $3, $4)`,
        [name || "", email, subject || "", message]
    );
}

async function listContactMessages(limit = 100) {
    const result = await query(
        "SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT $1",
        [limit]
    );
    return result.rows;
}

// ---------- Admin ----------

async function findAdminUser(username) {
    const result = await query("SELECT * FROM admin_users WHERE username = $1", [username]);
    return result.rows[0] || null;
}

async function createAdminUser(username, passwordHash) {
    const result = await query(
        "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
        [username, passwordHash]
    );
    return result.rows[0];
}

async function countAdminUsers() {
    const result = await query("SELECT COUNT(*)::int AS count FROM admin_users");
    return result.rows[0].count;
}

module.exports = {
    pool, query,
    getOrCreateAccount, updateAccount, findAccountBySubscriptionId, listAccounts,
    findPromoCode, incrementPromoUsage, listPromoCodes, createPromoCode, setPromoCodeActive, deletePromoCode,
    insertDetection, listDetections, getDetectionImage,
    listFleetVehicles, createFleetVehicle, updateFleetVehicle, deleteFleetVehicle,
    listShopProducts, createShopProduct, updateShopProduct, deleteShopProduct, getShopProductImage,
    insertContactMessage, listContactMessages,
    findAdminUser, createAdminUser, countAdminUsers,
};
