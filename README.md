# BarangayHub

**Barangay Rent and Reservation Management System**

A web app for lending the barangay's equipment and tools (chairs, tables, tents, sound system, tools…) to residents: taking reservations, releasing and receiving items, and collecting rent. There is no sign-in: anyone who can open the site can use it, so run it on the barangay office network or behind a protected link (see Running in production).

Built with **Node.js**, **Express 5**, **MongoDB** (Mongoose) and **EJS** views, styled after Material Design (Roboto, Material Symbols icons, cards, chips, stepper). Fonts and icons are served by the app itself, so it works without internet access to a CDN.

The app starts empty: add your items under **Equipment & tools → Add item**, then take reservations.

## How it works

Each reservation has two tracks: its **status** (where the item is) and its **rent** (what is owed and paid).

```
RESERVATION   Pending ──► Approved ──► Released ──► Returned
                 │            │
                 ├► Rejected  └► Cancelled
                 └► Cancelled

RENT          Rent = rate × units × days
              Balance = rent owed − paid (+ refunds given)
              Unpaid → Partial → Paid     (Cancelled/Rejected after paying → Refund due)
```

1. **Request:** saved as *Pending*. Stock for the dates is checked and the units are set aside. Rent uses the item's current rate.
2. **Approve / Reject / Cancel:** from approval on, rent is *owed*; before that it is *expected*.
3. **Collect rent:** record payments (full or partial) with OR numbers, at any time.
4. **Release** on the pick-up date (warns if rent is not fully paid).
5. **Return:** still out after the return date = *overdue*.

Each reservation page shows both tracks, the date of every step, and what to do next.

### Rules

- Status only moves forward through the allowed steps (enforced on the server).
- The rate is **fixed when the reservation is made**; changing an item's rate affects new reservations only.
- Item, units and dates can be edited only while *Pending* or *Approved*. Edits that change the rent are logged.
- *Cancelled* / *Rejected* reservations owe nothing; money already paid shows as **Refund due**.
- Payments can't exceed the balance, OR numbers can't repeat, dates can't be in the future.
- Reservations with money recorded can't be deleted (cancel instead). Removing a payment entry is logged.
- An item's units can't be lowered below what is already booked on an upcoming day.
- Late returns are not charged extra.

## Requirements

- Node.js 18.18 or newer (20 LTS recommended)
- MongoDB 6+ (local, or MongoDB Atlas)

## Setup (development)

```bash
npm install
cp .env.example .env          # edit MONGODB_URI
npm run dev                   # auto-restarts on changes
```

Open http://localhost:3000

## Running in production

1. **Settings** (`.env` or your host's environment variables):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `MONGODB_URI` | your Atlas / server connection string |
   | `TRUST_PROXY` | `1` if behind Nginx, Render, Railway, Fly, etc. |
   | `HTTPS` | `true` when served over HTTPS (turns on HSTS) |
   | `PORT` | port to listen on (default 3000) |
   | `TZ` | `Asia/Manila` (default) |

   The app **refuses to start** in production without `MONGODB_URI`.

2. **Install**
   ```bash
   npm ci --omit=dev
   ```

3. **Start** with a process manager so it restarts on crashes/reboots, e.g.
   ```bash
   npm install -g pm2
   pm2 start server.js --name barangayhub && pm2 save && pm2 startup
   ```
   or with Docker:
   ```bash
   docker build -t barangayhub .
   docker run -d --restart unless-stopped -p 3000:3000 --env-file .env barangayhub
   ```

4. **Control who can reach it.** The app has no sign-in, so anyone who can open the address can add, change and delete records. Either keep it on the barangay office network only (don't expose the port to the internet), or put it behind a reverse proxy that asks for a password (e.g. Nginx `auth_basic`, Caddy `basicauth`, Cloudflare Access). For HTTPS behind a proxy, set `TRUST_PROXY=1` and `HTTPS=true`. The proxy must pass the original `Host` header (`proxy_set_header Host $host;` in Nginx).

5. **Monitoring:** `GET /healthz` returns `{"status":"ok"}` (200) when the app and database are up, 503 otherwise.

6. **Backups:** turn on Atlas backups, or schedule `mongodump --uri "$MONGODB_URI" --out backups/$(date +%F)`.


## Security

- No sign-in (by choice). Limit access with the network or a password-protected proxy, as above.
- Cross-site request protection: every POST must come from this site (Origin/Referer check), so other websites can't submit forms to it.
- Security headers via Helmet: strict Content-Security-Policy (only this site's scripts; the one inline script needs a per-request nonce), HSTS when `HTTPS=true`, no framing, no MIME sniffing.
- Request bodies limited to 50 KB; error pages never show internal details in production.
- History log of every status change, edit, payment and refund (without names, since nobody signs in).

### Known limits

- Two staff saving bookings for the very same item and dates at the same instant could both pass the stock check. Unlikely at a barangay office; the stock page will show it.

## Project structure

```
server.js                App setup: security headers, routes, errors, graceful shutdown
config.js                Reads and checks environment settings
middleware/security.js   Same-origin (CSRF) check
models/                  Equipment, Reservation (status steps, rent maths)
routes/                  dashboard, equipment, reservations, payments
utils/availability.js    Stock and date helpers
views/                   EJS templates
public/                  Material-style CSS, JS (drawer, live availability & rent estimate, print, confirmations), logo
Dockerfile               Production container image
```

## Routes

| Method | Path | Action |
|---|---|---|
| GET | `/healthz` | Health check (public) |
| GET | `/` | Dashboard |
| GET/POST | `/equipment`, `/equipment/new` | List / add items |
| GET/PUT/DELETE | `/equipment/:id`, `/equipment/:id/edit` | View / edit / delete item |
| GET/POST | `/reservations`, `/reservations/new` | List (`?status=`, `?q=`) / create (as Pending) |
| GET/PUT/DELETE | `/reservations/:id`, `/reservations/:id/edit` | View / edit details / delete (only if no money) |
| PATCH | `/reservations/:id/status` | Next status step |
| POST | `/reservations/:id/payments` | Record payment or refund |
| DELETE | `/reservations/:id/payments/:pid` | Remove a payment/refund entry |
| GET | `/payments` | Rent & payments (`?from=&to=`) |
| GET | `/reservations/availability` | JSON: free units for `?equipment=&start=&end=&exclude=` (used live by the form) |

HTML forms send PUT/PATCH/DELETE via `method-override` (`?_method=PUT`).
