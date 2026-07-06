# Backend NaOgonie.pl (NO 4 SPEED GROUP)

Backend obsługujący: konta użytkowników i trial, płatności Stripe, kody
promocyjne, przesyłanie zdarzeń wykrycia (numer + zdjęcie + lokalizacja),
publiczną listę produktów sklepu oraz **panel administracyjny** do zarządzania
tym wszystkim.

Dane trzymane są w bazie **PostgreSQL** (wcześniejsza wersja używała płaskich
plików JSON — to już historia, ta wersja jest solidniejsza i gotowa na
większy ruch).

## 1. Baza danych — założenie i konfiguracja

Potrzebujesz gdzieś hostowanej bazy PostgreSQL. Najprościej na start:

- **Render.com** — „New” → „PostgreSQL” (mają darmowy plan na start).
- **Supabase** (supabase.com) — darmowy plan, baza Postgres + ładny podgląd danych w przeglądarce.
- **Neon** (neon.tech) — darmowy plan, dobrze się integruje z Render/Vercel.

Po założeniu dostaniesz **connection string** (adres w formacie
`postgres://uzytkownik:haslo@host:5432/nazwa_bazy`) — wklej go do `.env` jako
`DATABASE_URL`.

Następnie załaduj schemat (raz, przy pierwszym uruchomieniu):

```bash
psql "$DATABASE_URL" -f schema.sql
```

(Jeśli nie masz `psql` lokalnie — Supabase i większość hostingów ma wbudowany
edytor SQL w panelu przeglądarkowym, w którym możesz po prostu wkleić
zawartość `schema.sql` i uruchomić.)

Schemat tworzy tabele: `accounts`, `promo_codes`, `detections`,
`shop_products` (z sześcioma przykładowymi produktami na start), `contact_messages`, `admin_users`.

## 2. Konfiguracja lokalna

```bash
cd naogonie-payments
cp .env.example .env
# uzupełnij .env: DATABASE_URL, dane Stripe, SMTP, SESSION_SECRET
npm install
```

Utwórz pierwsze konto administratora panelu (tylko raz):

```bash
npm run create-admin -- twoj_login twoje_haslo
```

Uruchom serwer:

```bash
npm start
```

Panel administracyjny będzie dostępny pod `http://localhost:4242/admin`.

## 3. Panel administracyjny

Po zalogowaniu (`/admin`) masz pięć zakładek:

- **Konta** — lista wszystkich użytkowników, status (Premium / Trial / Promo / Brak dostępu), przyciski „+7 dni” i ręcznego nadania/odebrania Premium.
- **Kody promocyjne** — tworzenie nowych kodów (liczba dni, limit użyć, data wygaśnięcia), włączanie/wyłączanie, usuwanie.
- **Sklep** — produkty wyświetlane w zakładce „Sklep” w aplikacji. Dodawanie/edycja/ukrywanie **bez potrzeby aktualizacji aplikacji** — appka pobiera listę na żywo z `/shop/products`.
- **Wykrycia** — zdarzenia wysłane z aplikacji: numer, marka/model, zdjęcie (kliknij miniaturkę, żeby powiększyć), lokalizacja (klik → Google Maps), konto, które je zarejestrowało.
- **Kontakt** — wiadomości z formularza kontaktowego aplikacji.

Logowanie działa na sesjach (cookie) — jeden panel, wielu administratorów
(każdy może mieć swoje konto, utworzone przez `npm run create-admin`).

## 4. Konfiguracja Stripe

1. Załóż konto na https://dashboard.stripe.com/register (na start wystarczy tryb testowy).
2. **Products** → **Add product** → nazwa np. "NaOgonie.pl — abonament". W tym samym produkcie dodaj **trzy ceny cykliczne**:
   - 24,99 PLN, powtarzanie co 1 miesiąc
   - 139,99 PLN, powtarzanie co 6 miesięcy (Billing period: Custom → Every 6 months)
   - 249,99 PLN, powtarzanie co 1 rok
   Zapisz **Price ID** każdej z nich (`price_...`).
3. **Developers** → **API keys** → skopiuj **Secret key**.
4. **Developers** → **Webhooks** → **Add endpoint** → `https://TWOJ-BACKEND/webhook`, zdarzenia: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.paused`. Skopiuj **Signing secret**.

## 5. Trial i kody promocyjne

- Przy pierwszym logowaniu aplikacja woła `POST /account/init` — serwer nalicza 3 dni dostępu liczone od tego momentu, trzymane w tabeli `accounts`.
- Kody promocyjne (`POST /account/redeem-promo`) dodają dni dostępu niezależnie od triala i płatnej subskrypcji — zarządzasz nimi w panelu, zakładka „Kody promocyjne”.
- Dodatkowo `create-checkout-session` ma włączone `allow_promotion_codes: true` — to osobny, natywny mechanizm Stripe do rabatów przy samej płatności (Coupons w Dashboard Stripe).

## 6. Wykrycia (zdjęcia + lokalizacja)

Aplikacja mobilna wysyła `POST /detections` (multipart/form-data: `email`,
`plate`, `label`, `latitude`, `longitude`, `detectedAt`, opcjonalnie plik
`image`) przy każdym dopasowaniu numeru. Zdjęcia trzymane są bezpośrednio w
bazie (kolumna `BYTEA`) — wystarczające przy umiarkowanym ruchu; przy bardzo
dużej skali warto rozważyć przeniesienie zdjęć do zewnętrznego storage (np. S3),
ale nie jest to potrzebne na start.

## 7. Sklep

`GET /shop/products` — publiczny endpoint, aplikacja go odpytuje, żeby
wyświetlić aktualną listę produktów. Zarządzasz nią wyłącznie przez panel
administracyjny — nie trzeba nic zmieniać w kodzie aplikacji ani wysyłać jej
aktualizacji, żeby dodać/zmienić/ukryć produkt.

## 8. Formularz kontaktowy

`POST /contact` zapisuje wiadomość do bazy (widoczna w panelu, zakładka
„Kontakt”) i — jeśli skonfigurowano SMTP w `.env` — wysyła też e-mail.
Zapisanie do bazy działa niezależnie od tego, czy SMTP jest skonfigurowany.

## 9. Wdrożenie na produkcję

Tak jak wcześniej — Render/Railway/Fly.io. Pamiętaj o:
- ustawieniu wszystkich zmiennych z `.env` w panelu hostingu,
- uruchomieniu `schema.sql` na docelowej bazie produkcyjnej,
- utworzeniu konta administratora na produkcji (`npm run create-admin`, uruchomione w kontekście produkcyjnej bazy),
- zaktualizowaniu adresu webhooka w Stripe na docelowy URL.

## 10. Ograniczenia (do wiedzy, nie blokują startu)

- Sesje administratora trzymane są w pamięci procesu — jeśli hosting
  restartuje serwer (typowe przy darmowych planach po okresie bezczynności),
  trzeba się zalogować ponownie. Przy realnym ruchu warto dodać trwały
  magazyn sesji (np. `connect-pg-simple`, żeby trzymać sesje w tej samej
  bazie Postgres).
- Brak automatycznych backupów bazy — zależy to od dostawcy hostingu bazy;
  sprawdź, czy Twój plan (nawet darmowy) robi je automatycznie.
- Zdjęcia w bazie jako `BYTEA` są proste w obsłudze, ale przy bardzo dużej
  liczbie wykryć baza może urosnąć — do rozważenia w przyszłości przeniesienie
  na zewnętrzny storage plików.
