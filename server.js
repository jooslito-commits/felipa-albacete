// Servidor de "La Felipa ⇄ Albacete": guarda viajes y envía notificaciones push.
import express from "express";
import Database from "better-sqlite3";
import webpush from "web-push";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuración ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TZ = process.env.APP_TIMEZONE || "Europe/Madrid";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "";
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("[aviso] Notificaciones desactivadas: faltan VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY o VAPID_SUBJECT.");
}

// ---------- Base de datos ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "felipa.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    dir TEXT NOT NULL CHECK (dir IN ('ida','vuelta')),
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 4),
    driver TEXT NOT NULL,
    place TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    owner_device TEXT NOT NULL REFERENCES devices(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trips_date ON trips(date);
  CREATE TABLE IF NOT EXISTS riders (
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (trip_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    keys_json TEXT NOT NULL,
    notify_ida INTEGER NOT NULL DEFAULT 1,
    notify_vuelta INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const newId = () => crypto.randomBytes(12).toString("base64url");

// ---------- Utilidades de fecha (hora de España) ----------
function nowParts() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = t => f.find(p => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}
const toMinutes = (date, time) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60000;
};
function isPast(date, time, graceMin = 30) {
  const n = nowParts();
  return toMinutes(date, time) < toMinutes(n.date, n.time) - graceMin;
}
function dayWord(date) {
  const n = nowParts();
  const diff = (toMinutes(date, "12:00") - toMinutes(n.date, "12:00")) / 1440;
  if (diff === 0) return "hoy";
  if (diff === 1) return "mañana";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
const DIR_TEXT = { ida: "a Albacete", vuelta: "a La Felipa" };
const DEFAULT_PLACE = { ida: "Salida de La Felipa", vuelta: "Salida de Albacete" };

// ---------- Limpieza periódica ----------
function cleanup() {
  const n = nowParts();
  // Borra viajes de días anteriores (con sus pasajeros).
  db.prepare("DELETE FROM trips WHERE date < ?").run(n.date);
}
cleanup();
setInterval(cleanup, 60 * 60 * 1000).unref();

// ---------- Notificaciones ----------
async function sendTo(rows, payload) {
  if (!PUSH_ENABLED || !rows.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async r => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json) }, body, { TTL: 3600 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").run(r.endpoint);
      } else {
        console.error("[push] error", err.statusCode || err.message);
      }
    }
  }));
}
function notifyNewTrip(trip) {
  const col = trip.dir === "ida" ? "notify_ida" : "notify_vuelta";
  const rows = db.prepare(`SELECT endpoint, keys_json FROM subscriptions WHERE ${col} = 1 AND device_id != ?`).all(trip.owner_device);
  return sendTo(rows, {
    title: `Viaje ${DIR_TEXT[trip.dir]} ${dayWord(trip.date)} a las ${trip.time}`,
    body: `${trip.driver} tiene ${trip.seats} ${trip.seats === 1 ? "plaza" : "plazas"}. Recogida: ${trip.place}.`,
    tag: `trip-${trip.id}`, url: `/?dir=${trip.dir}`,
  });
}
function notifyDevice(deviceId, payload) {
  const rows = db.prepare("SELECT endpoint, keys_json FROM subscriptions WHERE device_id = ?").all(deviceId);
  return sendTo(rows, payload);
}

// ---------- App ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

// Límite sencillo de peticiones de escritura por IP (anti abuso).
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();
function rateLimit(req, res, next) {
  const k = req.ip;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (n > 30) return res.status(429).json({ error: "Demasiadas peticiones. Espera un minuto." });
  next();
}

// Identificación anónima del dispositivo: id + secreto guardados en el móvil.
function auth(req, res, next) {
  const id = String(req.get("X-Device-Id") || "");
  const secret = String(req.get("X-Device-Secret") || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || secret.length < 20 || secret.length > 128) {
    return res.status(401).json({ error: "Dispositivo no identificado." });
  }
  const row = db.prepare("SELECT secret_hash FROM devices WHERE id = ?").get(id);
  if (!row) {
    db.prepare("INSERT INTO devices (id, secret_hash, created_at) VALUES (?,?,?)").run(id, sha(secret), Date.now());
  } else if (row.secret_hash !== sha(secret)) {
    return res.status(401).json({ error: "Dispositivo no válido." });
  }
  req.device = id;
  next();
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

app.get("/api/config", (req, res) => {
  res.json({ pushEnabled: PUSH_ENABLED, vapidPublicKey: VAPID_PUBLIC_KEY, today: nowParts().date });
});

app.get("/api/trips", auth, (req, res) => {
  const n = nowParts();
  const trips = db.prepare("SELECT * FROM trips WHERE date >= ? ORDER BY date, time").all(n.date)
    .filter(t => !isPast(t.date, t.time));
  const riderStmt = db.prepare("SELECT device_id, name FROM riders WHERE trip_id = ? ORDER BY created_at");
  res.json({
    trips: trips.map(t => {
      const rs = riderStmt.all(t.id);
      return {
        id: t.id, dir: t.dir, date: t.date, time: t.time, seats: t.seats,
        driver: t.driver, place: t.place, note: t.note,
        mine: t.owner_device === req.device,
        joined: rs.some(r => r.device_id === req.device),
        riders: rs.map(r => r.name),
      };
    }),
  });
});

app.post("/api/trips", rateLimit, auth, (req, res) => {
  const b = req.body || {};
  const dir = b.dir === "vuelta" ? "vuelta" : b.dir === "ida" ? "ida" : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : null;
  const seats = Number(b.seats);
  const driver = clean(b.driver, 40);
  if (!dir || !date || !time || !driver || !(seats >= 1 && seats <= 4 && Number.isInteger(seats))) {
    return res.status(400).json({ error: "Revisa sentido, día, hora, plazas y nombre." });
  }
  if (isPast(date, time, 0)) return res.status(400).json({ error: "Esa hora ya ha pasado." });
  const n = nowParts();
  if (toMinutes(date, time) - toMinutes(n.date, n.time) > 30 * 1440) {
    return res.status(400).json({ error: "Solo se pueden publicar viajes de los próximos 30 días." });
  }
  const trip = {
    id: newId(), dir, date, time, seats, driver,
    place: clean(b.place, 80) || DEFAULT_PLACE[dir], note: clean(b.note, 200),
    owner_device: req.device, created_at: Date.now(),
  };
  db.prepare(`INSERT INTO trips (id, dir, date, time, seats, driver, place, note, owner_device, created_at)
              VALUES (@id,@dir,@date,@time,@seats,@driver,@place,@note,@owner_device,@created_at)`).run(trip);
  res.status(201).json({ id: trip.id });
  notifyNewTrip(trip).catch(e => console.error("[push]", e));
});

app.delete("/api/trips/:id", rateLimit, auth, (req, res) => {
  const t = db.prepare("SELECT * FROM trips WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Ese viaje ya no existe." });
  if (t.owner_device !== req.device) return res.status(403).json({ error: "Solo quien publicó el viaje puede cancelarlo." });
  const riders = db.prepare("SELECT device_id FROM riders WHERE trip_id = ?").all(t.id);
  db.prepare("DELETE FROM trips WHERE id = ?").run(t.id);
  res.json({ ok: true });
  for (const r of riders) {
    notifyDevice(r.device_id, {
      title: "Viaje cancelado",
      body: `${t.driver} ha cancelado el viaje ${DIR_TEXT[t.dir]} de ${dayWord(t.date)} a las ${t.time}.`,
      tag: `trip-${t.id}`, url: `/?dir=${t.dir}`,
    }).catch(() => {});
  }
});

const joinTx = db.transaction((tripId, deviceId, name) => {
  const t = db.prepare("SELECT * FROM trips WHERE id = ?").get(tripId);
  if (!t) return { status: 404, error: "Ese viaje ya no existe." };
  if (t.owner_device === deviceId) return { status: 400, error: "No puedes apuntarte a tu propio viaje." };
  if (isPast(t.date, t.time, 0)) return { status: 400, error: "Este viaje ya ha salido." };
  const already = db.prepare("SELECT 1 FROM riders WHERE trip_id = ? AND device_id = ?").get(tripId, deviceId);
  if (already) return { status: 200, trip: t, already: true };
  const count = db.prepare("SELECT COUNT(*) AS n FROM riders WHERE trip_id = ?").get(tripId).n;
  if (count >= t.seats) return { status: 409, error: "Lo sentimos, el coche ya está completo." };
  db.prepare("INSERT INTO riders (trip_id, device_id, name, created_at) VALUES (?,?,?,?)").run(tripId, deviceId, name, Date.now());
  return { status: 200, trip: t, left: t.seats - count - 1 };
});

app.post("/api/trips/:id/join", rateLimit, auth, (req, res) => {
  const name = clean(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: "Escribe tu nombre." });
  const r = joinTx(req.params.id, req.device, name);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
  if (!r.already) {
    notifyDevice(r.trip.owner_device, {
      title: `${name} se ha apuntado`,
      body: `Viaje ${DIR_TEXT[r.trip.dir]} de ${dayWord(r.trip.date)} a las ${r.trip.time}. ${r.left ? `Quedan ${r.left} plazas.` : "El coche está completo."}`,
      tag: `trip-${r.trip.id}-riders`, url: `/?dir=${r.trip.dir}`,
    }).catch(() => {});
  }
});

app.delete("/api/trips/:id/join", rateLimit, auth, (req, res) => {
  const t = db.prepare("SELECT * FROM trips WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Ese viaje ya no existe." });
  const r = db.prepare("SELECT name FROM riders WHERE trip_id = ? AND device_id = ?").get(t.id, req.device);
  if (!r) return res.json({ ok: true });
  db.prepare("DELETE FROM riders WHERE trip_id = ? AND device_id = ?").run(t.id, req.device);
  res.json({ ok: true });
  notifyDevice(t.owner_device, {
    title: `${r.name} ya no va`,
    body: `Se ha liberado una plaza en tu viaje ${DIR_TEXT[t.dir]} de ${dayWord(t.date)} a las ${t.time}.`,
    tag: `trip-${t.id}-riders`, url: `/?dir=${t.dir}`,
  }).catch(() => {});
});

// Suscripción a notificaciones y preferencias
app.post("/api/subscription", rateLimit, auth, (req, res) => {
  const s = req.body?.subscription;
  const endpoint = typeof s?.endpoint === "string" ? s.endpoint : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !s.keys?.p256dh || !s.keys?.auth) {
    return res.status(400).json({ error: "Suscripción no válida." });
  }
  const ida = req.body.ida === false ? 0 : 1;
  const vuelta = req.body.vuelta === false ? 0 : 1;
  db.prepare(`INSERT INTO subscriptions (endpoint, device_id, keys_json, notify_ida, notify_vuelta, created_at)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET device_id=excluded.device_id, keys_json=excluded.keys_json,
              notify_ida=excluded.notify_ida, notify_vuelta=excluded.notify_vuelta`)
    .run(endpoint, req.device, JSON.stringify({ p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }), ida, vuelta, Date.now());
  res.json({ ok: true });
});

app.delete("/api/subscription", rateLimit, auth, (req, res) => {
  db.prepare("DELETE FROM subscriptions WHERE device_id = ?").run(req.device);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    if (file.endsWith("sw.js") || file.endsWith(".html") || file.endsWith(".webmanifest")) {
      res.set("Cache-Control", "no-cache");
    }
  },
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno." });
});

export { app, db };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`La Felipa ⇄ Albacete escuchando en el puerto ${PORT}`));
}
