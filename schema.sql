-- Schemat bazy danych NaOgonie.pl (NO 4 SPEED GROUP)
-- Uruchom raz przy pierwszym wdrożeniu: psql $DATABASE_URL -f schema.sql

CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    premium BOOLEAN NOT NULL DEFAULT FALSE,
    subscription_id TEXT,
    trial_starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    promo_ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    days INTEGER NOT NULL,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS detections (
    id SERIAL PRIMARY KEY,
    account_email TEXT NOT NULL,
    plate TEXT NOT NULL,
    label TEXT,
    image BYTEA,
    image_mime TEXT DEFAULT 'image/jpeg',
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    detected_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_detections_email ON detections(account_email);
CREATE INDEX IF NOT EXISTS idx_detections_detected_at ON detections(detected_at DESC);

CREATE TABLE IF NOT EXISTS shop_products (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    price TEXT,
    url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_messages (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT,
    subject TEXT,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Przykładowe produkty startowe (odpowiadają tym wpisanym wcześniej na sztywno w aplikacji).
INSERT INTO shop_products (title, description, price, url, sort_order) VALUES
    ('Kamera WiFi do montażu tylnego', 'Gotowa do podłączenia, kompatybilna ze skanerem NaOgonie.pl', 'od 149 zł', 'https://naogonie.pl/sklep/kamera-wifi', 1),
    ('Zestaw ESP32-S3 + kamera OV3660', 'Moduł do samodzielnego zaprogramowania własnej kamery', '129 zł', 'https://naogonie.pl/sklep/esp32-s3-cam', 2),
    ('Uchwyt magnetyczny na szybę tylną', 'Stabilny montaż kamery bez wiercenia', '39 zł', 'https://naogonie.pl/sklep/uchwyt-magnetyczny', 3),
    ('Kabel zasilający USB-C 5 m', 'Do poprowadzenia zasilania kamery przez wnętrze auta', '29 zł', 'https://naogonie.pl/sklep/kabel-usb-c-5m', 4),
    ('Obudowa wodoodporna na kamerę', 'Ochrona modułu przed warunkami atmosferycznymi', '59 zł', 'https://naogonie.pl/sklep/obudowa-wodoodporna', 5),
    ('Naklejka ostrzegawcza „Pojazd monitorowany”', 'Zestaw 2 sztuk, odporna na warunki atmosferyczne', '19 zł', 'https://naogonie.pl/sklep/naklejka-ostrzegawcza', 6)
ON CONFLICT DO NOTHING;
