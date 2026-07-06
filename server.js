// server.js — backend NaOgonie.pl (NO 4 SPEED GROUP), wersja z PostgreSQL i panelem admina.
//
// Główne grupy endpointów:
//   /account/*      — logowanie, trial, status dostępu (aplikacja mobilna/web)
//   /account/redeem-promo, /create-checkout-session, /webhook — jak wcześniej, teraz na bazie danych
//   /detections      — przyjmowanie zdarzeń wykrycia z aplikacji (zdjęcie + lokalizacja)
//   /shop/products    — publiczna lista produktów sklepu (czyta aplikacja mobilna)
//   /admin/*          — panel administracyjny (logowanie sesyjne + API do zarządzania wszystkim)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const db = require("./db");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB max na zdjęcie

const PORT = process.env.PORT || 4242;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:8000";
const TRIAL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRICE_IDS = {
    monthly: process.env.STRIPE_PRICE_MONTHLY,
    sixmonth: process.env.STRIPE_PRICE_SIXMONTH,
    yearly: process.env.STRIPE_PRICE_YEARLY,
};

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "kontakt@naogonie.pl";
let mailTransporter = null;
if (process.env.SMTP_HOST) {
    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
}

function computeStatus(account) {
    const now = Date.now();
    const trialEndsAt = new Date(account.trial_starts_at).getTime() + TRIAL_DAYS * DAY_MS;
    const trialActive = now < trialEndsAt;
    const promoActive = !!(account.promo_ends_at && now < new Date(account.promo_ends_at).getTime());
    const premium = !!account.premium;

    return {
        hasAccess: premium || trialActive || promoActive,
        premium,
        trialActive,
        trialEndsAt: new Date(trialEndsAt).toISOString(),
        trialDaysLeft: trialActive ? Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS)) : 0,
        promoActive,
        promoEndsAt: account.promo_ends_at ? new Date(account.promo_ends_at).toISOString() : null,
    };
}

// ---------- Webhook Stripe (surowe body, przed express.json()) ----------
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error("Błąd weryfikacji webhooka Stripe:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object;
                const email = session.customer_details?.email || session.customer_email;
                if (email) {
                    await db.getOrCreateAccount(email);
                    await db.updateAccount(email, { premium: true, subscription_id: session.subscription });
                }
                break;
            }
            case "customer.subscription.deleted":
            case "customer.subscription.paused": {
                const subscription = event.data.object;
                const account = await db.findAccountBySubscriptionId(subscription.id);
                if (account) await db.updateAccount(account.email, { premium: false });
                break;
            }
        }
    } catch (err) {
        console.error("Błąd obsługi webhooka:", err);
    }
    res.json({ received: true });
});

app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(session({
    secret: process.env.SESSION_SECRET || "zmien-ten-sekret-w-env",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12h
}));

// ============================================================
// KONTO / TRIAL (aplikacja mobilna i web)
// ============================================================

app.post("/account/init", async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Brak adresu e-mail." });
        const account = await db.getOrCreateAccount(email);
        res.json(computeStatus(account));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Błąd serwera." });
    }
});

app.get("/account/status", async (req, res) => {
    try {
        const email = (req.query.email || "").toLowerCase();
        if (!email) return res.status(400).json({ error: "Brak parametru email." });
        const account = await db.getOrCreateAccount(email);
        res.json(computeStatus(account));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Błąd serwera." });
    }
});

app.get("/premium-status", async (req, res) => {
    try {
        const email = (req.query.email || "").toLowerCase();
        if (!email) return res.status(400).json({ error: "Brak parametru email." });
        const account = await db.getOrCreateAccount(email);
        res.json({ premium: computeStatus(account).hasAccess });
    } catch (err) {
        res.status(500).json({ error: "Błąd serwera." });
    }
});

app.post("/account/redeem-promo", async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ error: "Wymagane: email i code." });

        const promo = await db.findPromoCode(code);
        if (!promo) return res.status(404).json({ error: "Nieprawidłowy kod promocyjny." });
        if (!promo.active) return res.status(400).json({ error: "Ten kod jest już nieaktywny." });
        if (promo.expires_at && Date.now() > new Date(promo.expires_at).getTime()) {
            return res.status(400).json({ error: "Ten kod promocyjny wygasł." });
        }
        if (promo.max_uses != null && promo.used_count >= promo.max_uses) {
            return res.status(400).json({ error: "Ten kod osiągnął limit wykorzystań." });
        }

        const account = await db.getOrCreateAccount(email);
        const now = Date.now();
        const currentPromoEnd = account.promo_ends_at && new Date(account.promo_ends_at).getTime() > now
            ? new Date(account.promo_ends_at).getTime() : now;
        const newPromoEnd = new Date(currentPromoEnd + promo.days * DAY_MS).toISOString();

        await db.updateAccount(email, { promo_ends_at: newPromoEnd });
        await db.incrementPromoUsage(promo.id);

        const updated = await db.getOrCreateAccount(email);
        res.json({ ok: true, addedDays: promo.days, ...computeStatus(updated) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Błąd serwera." });
    }
});

// ============================================================
// PŁATNOŚCI STRIPE
// ============================================================

app.post("/create-checkout-session", async (req, res) => {
    try {
        const { email, plan } = req.body;
        if (!email) return res.status(400).json({ error: "Brak adresu e-mail." });
        const priceId = PRICE_IDS[plan];
        if (!priceId) return res.status(400).json({ error: `Nieprawidłowy plan "${plan}".` });

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            payment_method_types: ["card", "blik", "p24"],
            customer_email: email,
            allow_promotion_codes: true,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${FRONTEND_URL}/?payment=success`,
            cancel_url: `${FRONTEND_URL}/?payment=cancelled`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// WYKRYCIA (aplikacja wysyła zdarzenie po dopasowaniu numeru)
// ============================================================

app.post("/detections", upload.single("image"), async (req, res) => {
    try {
        const { email, plate, label, latitude, longitude, detectedAt } = req.body;
        if (!email || !plate) return res.status(400).json({ error: "Wymagane: email i plate." });

        const saved = await db.insertDetection({
            email, plate, label,
            imageBuffer: req.file ? req.file.buffer : null,
            imageMime: req.file ? req.file.mimetype : null,
            latitude: latitude ? parseFloat(latitude) : null,
            longitude: longitude ? parseFloat(longitude) : null,
            detectedAt: detectedAt ? new Date(parseInt(detectedAt, 10)) : new Date(),
        });
        res.json({ ok: true, id: saved.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Błąd zapisu wykrycia." });
    }
});

app.get("/detections/:id/image", async (req, res) => {
    try {
        const row = await db.getDetectionImage(req.params.id);
        if (!row || !row.image) return res.status(404).send("Brak zdjęcia.");
        res.set("Content-Type", row.image_mime || "image/jpeg");
        res.send(row.image);
    } catch (err) {
        res.status(500).send("Błąd serwera.");
    }
});

// ============================================================
// SKLEP (publiczny odczyt — czyta aplikacja mobilna)
// ============================================================

app.get("/shop/products", async (req, res) => {
    try {
        const products = await db.listShopProducts(true);
        res.json(products.map(p => ({
            id: p.id, title: p.title, description: p.description, price: p.price, url: p.url,
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Błąd serwera." });
    }
});

// ============================================================
// KONTAKT
// ============================================================

app.post("/contact", async (req, res) => {
    const { name, email, message, subject } = req.body;
    if (!email || !message) return res.status(400).json({ error: "Wymagane: email i message." });

    try {
        await db.insertContactMessage({ name, email, subject, message });
    } catch (err) {
        console.error("Błąd zapisu wiadomości kontaktowej:", err);
    }

    if (!mailTransporter) {
        return res.status(200).json({ ok: true, mailSent: false });
    }
    try {
        await mailTransporter.sendMail({
            from: `"NaOgonie.pl — formularz" <${process.env.SMTP_USER}>`,
            to: CONTACT_EMAIL,
            replyTo: email,
            subject: `[NaOgonie.pl] ${subject || "Wiadomość z formularza"}`,
            text: `Od: ${name || "—"} <${email}>\n\n${message}`,
        });
        res.json({ ok: true, mailSent: true });
    } catch (err) {
        console.error("Błąd wysyłki e-mail:", err);
        res.json({ ok: true, mailSent: false });
    }
});

// ============================================================
// PANEL ADMINISTRACYJNY
// ============================================================

function requireAdmin(req, res, next) {
    if (req.session && req.session.adminUsername) return next();
    res.status(401).json({ error: "Wymagane logowanie administratora." });
}

app.post("/admin/login", async (req, res) => {
    const { username, password } = req.body;
    const admin = await db.findAdminUser(username);
    if (!admin) return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
    req.session.adminUsername = admin.username;
    res.json({ ok: true, username: admin.username });
});

app.post("/admin/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

app.get("/admin/me", (req, res) => {
    res.json({ loggedIn: !!(req.session && req.session.adminUsername), username: req.session?.adminUsername || null });
});

// Jednorazowy endpoint do utworzenia PIERWSZEGO konta administratora — przydatny,
// gdy hosting (np. darmowy plan Render) nie daje dostępu do Shell/SSH.
// Działa tylko, gdy: (1) w .env ustawiono SETUP_SECRET, (2) podano ten sam sekret
// w adresie, (3) żaden administrator jeszcze nie istnieje. Po użyciu usuń
// SETUP_SECRET z Environment na hostingu, żeby zamknąć ten endpoint na dobre.
app.get("/admin/setup", async (req, res) => {
    try {
        if (!process.env.SETUP_SECRET) {
            return res.status(403).send("Endpoint wyłączony — brak SETUP_SECRET w konfiguracji serwera.");
        }
        if (req.query.secret !== process.env.SETUP_SECRET) {
            return res.status(403).send("Nieprawidłowy sekret.");
        }
        const existingCount = await db.countAdminUsers();
        if (existingCount > 0) {
            return res.status(400).send("Administrator już istnieje — ten endpoint działa tylko przy pierwszym uruchomieniu.");
        }
        const { username, password } = req.query;
        if (!username || !password) {
            return res.status(400).send("Brak danych. Użyj adresu w formacie: /admin/setup?secret=TWOJSEKRET&username=LOGIN&password=HASLO");
        }
        const hash = await bcrypt.hash(String(password), 10);
        await db.createAdminUser(String(username), hash);
        res.send(
            `Utworzono administratora: ${username}. Zaloguj się teraz na /admin. ` +
            `Następnie usuń zmienną SETUP_SECRET z Environment na hostingu, żeby zamknąć ten endpoint.`
        );
    } catch (err) {
        console.error(err);
        res.status(500).send("Błąd: " + err.message);
    }
});

// ---- Konta ----
app.get("/admin/api/accounts", requireAdmin, async (req, res) => {
    const accounts = await db.listAccounts(500, 0);
    res.json(accounts.map(a => ({ ...a, ...computeStatus(a) })));
});

app.post("/admin/api/accounts/:email/grant-days", requireAdmin, async (req, res) => {
    const { days } = req.body;
    const email = req.params.email;
    const account = await db.getOrCreateAccount(email);
    const now = Date.now();
    const base = account.promo_ends_at && new Date(account.promo_ends_at).getTime() > now
        ? new Date(account.promo_ends_at).getTime() : now;
    const newEnd = new Date(base + parseInt(days, 10) * DAY_MS).toISOString();
    const updated = await db.updateAccount(email, { promo_ends_at: newEnd });
    res.json({ ...updated, ...computeStatus(updated) });
});

app.post("/admin/api/accounts/:email/set-premium", requireAdmin, async (req, res) => {
    const { premium } = req.body;
    const updated = await db.updateAccount(req.params.email, { premium: !!premium });
    res.json({ ...updated, ...computeStatus(updated) });
});

// ---- Kody promocyjne ----
app.get("/admin/api/promo-codes", requireAdmin, async (req, res) => {
    res.json(await db.listPromoCodes());
});

app.post("/admin/api/promo-codes", requireAdmin, async (req, res) => {
    const { code, days, maxUses, expiresAt } = req.body;
    if (!code || !days) return res.status(400).json({ error: "Wymagane: code i days." });
    const created = await db.createPromoCode({ code, days: parseInt(days, 10), maxUses: maxUses ? parseInt(maxUses, 10) : null, expiresAt });
    res.json(created);
});

app.post("/admin/api/promo-codes/:id/toggle", requireAdmin, async (req, res) => {
    await db.setPromoCodeActive(req.params.id, !!req.body.active);
    res.json({ ok: true });
});

app.delete("/admin/api/promo-codes/:id", requireAdmin, async (req, res) => {
    await db.deletePromoCode(req.params.id);
    res.json({ ok: true });
});

// ---- Sklep ----
app.get("/admin/api/shop-products", requireAdmin, async (req, res) => {
    res.json(await db.listShopProducts(false));
});

app.post("/admin/api/shop-products", requireAdmin, async (req, res) => {
    const created = await db.createShopProduct(req.body);
    res.json(created);
});

app.put("/admin/api/shop-products/:id", requireAdmin, async (req, res) => {
    const updated = await db.updateShopProduct(req.params.id, req.body);
    res.json(updated);
});

app.delete("/admin/api/shop-products/:id", requireAdmin, async (req, res) => {
    await db.deleteShopProduct(req.params.id);
    res.json({ ok: true });
});

// ---- Wykrycia ----
app.get("/admin/api/detections", requireAdmin, async (req, res) => {
    const email = req.query.email || null;
    const detections = await db.listDetections(200, 0, email);
    res.json(detections);
});

// ---- Wiadomości kontaktowe ----
app.get("/admin/api/contact-messages", requireAdmin, async (req, res) => {
    res.json(await db.listContactMessages(200));
});

// Statyczne pliki panelu admina (frontend) — musi być po zdefiniowaniu tras API powyżej.
app.use("/admin", express.static(path.join(__dirname, "admin")));

app.get("/", (req, res) => {
    res.send("NaOgonie.pl backend — działa. Panel administracyjny: /admin");
});

app.listen(PORT, () => console.log(`Backend NaOgonie.pl nasłuchuje na porcie ${PORT}`));
