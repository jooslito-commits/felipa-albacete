// Servidor de "La Felipa ⇄ Albacete": guarda viajes y envía notificaciones push.
// Funciona igual en Vercel (función sin servidor + base de datos Turso) y en un servidor normal.
import express from "express";
import webpush from "web-push";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuración ----------
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.APP_TIMEZONE || "Europe/Madrid";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "";

// Base de datos: Turso si hay TURSO_DATABASE_URL; si no, un archivo local (para pruebas o servidor propio).
// Con Turso se usa el cliente "web" (sin piezas nativas), que es el que funciona en Vercel.
class ConfigError extends Error {}
let dbClient = null;
async function getDb() {
  if (dbClient) return dbClient;
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim() || undefined;
  if (url) {
    if (!/^(libsql|https|wss?):\/\//.test(url)) throw new ConfigError("TURSO_DATABASE_URL no es válida: debe empezar por libsql://");
    if (!authToken) throw new ConfigError("Falta la variable TURSO_AUTH_TOKEN.");
    const { createClient } = await import("@libsql/client/web");
    dbClient = createClient({ url, authToken });
  } else {
    if (process.env.VERCEL) throw new ConfigError("Falta la variable TURSO_DATABASE_URL.");
    const dir = process.env.DATA_DIR || path.join(__dirname, "data");
    fs.mkdirSync(dir, { recursive: true });
    const { createClient } = await import("@libsql/client");
    dbClient = createClient({ url: "file:" + path.join(dir, "felipa.db") });
  }
  return dbClient;
}
const db = {
  execute: async (...a) => (await getDb()).execute(...a),
  executeMultiple: async (...a) => (await getDb()).executeMultiple(...a),
  batch: async (...a) => (await getDb()).batch(...a),
  close: () => dbClient?.close(),
};
const q = (sql, ...args) => db.execute({ sql, args });
const one = async (sql, ...args) => (await q(sql, ...args)).rows[0];
const all = async (sql, ...args) => (await q(sql, ...args)).rows;

// Traduce errores de conexión a un mensaje comprensible (sin mostrar secretos).
function explain(err) {
  if (err instanceof ConfigError) return err.message + " Revísala en Vercel → Settings → Environment Variables y vuelve a desplegar.";
  const m = String(err?.message || err);
  if (/401|unauthori|token|jwt/i.test(m)) return "Turso rechaza el token (TURSO_AUTH_TOKEN). Crea uno nuevo, cámbialo en Vercel y vuelve a desplegar.";
  if (/404|not found|ENOTFOUND|getaddrinfo/i.test(m)) return "No se encuentra la base de datos de Turso. Revisa TURSO_DATABASE_URL.";
  return "No se puede conectar con la base de datos: " + m.slice(0, 200);
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const newId = () => crypto.randomBytes(12).toString("base64url");

// ---------- Preparación (una vez por arranque) ----------
let push = { enabled: false, publicKey: "" };
async function init() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      dir TEXT NOT NULL CHECK (dir IN ('ida','vuelta')),
      date TEXT NOT NULL, time TEXT NOT NULL,
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 4),
      driver TEXT NOT NULL, place TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      owner_device TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trips_date ON trips(date);
    CREATE TABLE IF NOT EXISTS riders (
      trip_id TEXT NOT NULL, device_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (trip_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY, device_id TEXT NOT NULL, keys_json TEXT NOT NULL,
      notify_ida INTEGER NOT NULL DEFAULT 1, notify_vuelta INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subs_device ON subscriptions(device_id);
  `);

  // Claves de los avisos: variables de entorno si existen; si no, se generan una vez y se guardan en la base de datos.
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const row = await one("SELECT value FROM settings WHERE key = 'vapid'");
    if (row) keys = JSON.parse(row.value);
    else {
      const k = webpush.generateVAPIDKeys();
      await q("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)", JSON.stringify(k));
      keys = JSON.parse((await one("SELECT value FROM settings WHERE key = 'vapid'")).value); // por si otro arranque ganó
      console.log("[aviso] Claves de avisos generadas y guardadas en la base de datos.");
    }
  }
  if (VAPID_SUBJECT) {
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    push = { enabled: true, publicKey: keys.publicKey };
  } else {
    push = { enabled: false, publicKey: keys.publicKey };
    console.warn("[aviso] Notificaciones desactivadas: falta la variable VAPID_SUBJECT (tu correo, con formato mailto:).");
  }
}
let ready = null;
const ensureReady = () => (ready ||= init().catch(e => { ready = null; throw e; }));

// ---------- Fechas (hora de España) ----------
function nowParts() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
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

// Borra viajes de días anteriores (como mucho una vez por hora y arranque).
let lastCleanup = 0;
async function cleanup() {
  if (Date.now() - lastCleanup < 3600_000) return;
  lastCleanup = Date.now();
  const today = nowParts().date;
  await db.batch([
    { sql: "DELETE FROM riders WHERE trip_id IN (SELECT id FROM trips WHERE date < ?)", args: [today] },
    { sql: "DELETE FROM trips WHERE date < ?", args: [today] },
  ], "write");
}

// ---------- Notificaciones ----------
// Se esperan antes de responder: en Vercel el trabajo pendiente tras la respuesta puede cortarse.
async function sendTo(rows, payload) {
  if (!push.enabled || !rows.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async r => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json) }, body, { TTL: 3600, timeout: 5000 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await q("DELETE FROM subscriptions WHERE endpoint = ?", r.endpoint).catch(() => {});
      else console.error("[push] error", err.statusCode || err.message);
    }
  }));
}
async function notifyNewTrip(trip) {
  const col = trip.dir === "ida" ? "notify_ida" : "notify_vuelta";
  const rows = await all(`SELECT endpoint, keys_json FROM subscriptions WHERE ${col} = 1 AND device_id != ?`, trip.owner_device);
  await sendTo(rows, {
    title: `Viaje ${DIR_TEXT[trip.dir]} ${dayWord(trip.date)} a las ${trip.time}`,
    body: `${trip.driver} tiene ${trip.seats} ${trip.seats === 1 ? "plaza" : "plazas"}. Recogida: ${trip.place}.`,
    tag: `trip-${trip.id}`, url: `/?dir=${trip.dir}`,
  });
}
async function notifyDevice(deviceId, payload) {
  await sendTo(await all("SELECT endpoint, keys_json FROM subscriptions WHERE device_id = ?", deviceId), payload);
}
const safely = p => p.catch(e => console.error("[push]", e.message));

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
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.use("/api", wrap(async (req, res, next) => { await ensureReady(); next(); }));

// Límite sencillo de peticiones de escritura por IP (anti abuso).
const hits = new Map();
let hitsWindow = Date.now();
function rateLimit(req, res, next) {
  if (Date.now() - hitsWindow > 60_000) { hits.clear(); hitsWindow = Date.now(); }
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 30) return res.status(429).json({ error: "Demasiadas peticiones. Espera un minuto." });
  next();
}

// Identificación anónima del dispositivo: id + secreto guardados en el móvil.
const auth = wrap(async (req, res, next) => {
  const id = String(req.get("X-Device-Id") || "");
  const secret = String(req.get("X-Device-Secret") || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || secret.length < 20 || secret.length > 128) {
    return res.status(401).json({ error: "Dispositivo no identificado." });
  }
  await q("INSERT OR IGNORE INTO devices (id, secret_hash, created_at) VALUES (?,?,?)", id, sha(secret), Date.now());
  const row = await one("SELECT secret_hash FROM devices WHERE id = ?", id);
  if (row.secret_hash !== sha(secret)) return res.status(401).json({ error: "Dispositivo no válido." });
  req.device = id;
  next();
});

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

app.get("/api/config", (req, res) => {
  res.json({ pushEnabled: push.enabled, vapidPublicKey: push.publicKey, today: nowParts().date });
});

app.get("/api/trips", auth, wrap(async (req, res) => {
  await cleanup();
  const trips = (await all("SELECT * FROM trips WHERE date >= ? ORDER BY date, time", nowParts().date))
    .filter(t => !isPast(t.date, t.time));
  const riders = trips.length
    ? await all(`SELECT trip_id, device_id, name FROM riders WHERE trip_id IN (${trips.map(() => "?").join(",")}) ORDER BY created_at`, ...trips.map(t => t.id))
    : [];
  res.json({
    trips: trips.map(t => {
      const rs = riders.filter(r => r.trip_id === t.id);
      return {
        id: t.id, dir: t.dir, date: t.date, time: t.time, seats: Number(t.seats),
        driver: t.driver, place: t.place, note: t.note,
        mine: t.owner_device === req.device,
        joined: rs.some(r => r.device_id === req.device),
        riders: rs.map(r => r.name),
      };
    }),
  });
}));

app.post("/api/trips", rateLimit, auth, wrap(async (req, res) => {
  const b = req.body || {};
  const dir = b.dir === "vuelta" ? "vuelta" : b.dir === "ida" ? "ida" : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : null;
  const seats = Number(b.seats);
  const driver = clean(b.driver, 40);
  if (!dir || !date || !time || !driver || !(Number.isInteger(seats) && seats >= 1 && seats <= 4)) {
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
  await q(`INSERT INTO trips (id, dir, date, time, seats, driver, place, note, owner_device, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    trip.id, dir, date, time, seats, driver, trip.place, trip.note, trip.owner_device, trip.created_at);
  await safely(notifyNewTrip(trip));
  res.status(201).json({ id: trip.id });
}));

app.delete("/api/trips/:id", rateLimit, auth, wrap(async (req, res) => {
  const t = await one("SELECT * FROM trips WHERE id = ?", req.params.id);
  if (!t) return res.status(404).json({ error: "Ese viaje ya no existe." });
  if (t.owner_device !== req.device) return res.status(403).json({ error: "Solo quien publicó el viaje puede cancelarlo." });
  const riders = await all("SELECT device_id FROM riders WHERE trip_id = ?", t.id);
  await db.batch([
    { sql: "DELETE FROM riders WHERE trip_id = ?", args: [t.id] },
    { sql: "DELETE FROM trips WHERE id = ?", args: [t.id] },
  ], "write");
  await safely(Promise.all(riders.map(r => notifyDevice(r.device_id, {
    title: "Viaje cancelado",
    body: `${t.driver} ha cancelado el viaje ${DIR_TEXT[t.dir]} de ${dayWord(t.date)} a las ${t.time}.`,
    tag: `trip-${t.id}`, url: `/?dir=${t.dir}`,
  }))));
  res.json({ ok: true });
}));

app.post("/api/trips/:id/join", rateLimit, auth, wrap(async (req, res) => {
  const name = clean(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: "Escribe tu nombre." });
  const t = await one("SELECT * FROM trips WHERE id = ?", req.params.id);
  if (!t) return res.status(404).json({ error: "Ese viaje ya no existe." });
  if (t.owner_device === req.device) return res.status(400).json({ error: "No puedes apuntarte a tu propio viaje." });
  if (isPast(t.date, t.time, 0)) return res.status(400).json({ error: "Este viaje ya ha salido." });
  if (await one("SELECT 1 AS x FROM riders WHERE trip_id = ? AND device_id = ?", t.id, req.device)) return res.json({ ok: true });
  // Una sola sentencia: solo inserta si aún quedan plazas (evita pasarse aunque dos personas se apunten a la vez).
  const r = await q(`INSERT OR IGNORE INTO riders (trip_id, device_id, name, created_at)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM riders WHERE trip_id = ?) < (SELECT seats FROM trips WHERE id = ?)`,
    t.id, req.device, name, Date.now(), t.id, t.id);
  if (!r.rowsAffected) return res.status(409).json({ error: "Lo sentimos, el coche ya está completo." });
  const left = Number(t.seats) - Number((await one("SELECT COUNT(*) AS n FROM riders WHERE trip_id = ?", t.id)).n);
  await safely(notifyDevice(t.owner_device, {
    title: `${name} se ha apuntado`,
    body: `Viaje ${DIR_TEXT[t.dir]} de ${dayWord(t.date)} a las ${t.time}. ${left > 0 ? `Quedan ${left} ${left === 1 ? "plaza" : "plazas"}.` : "El coche está completo."}`,
    tag: `trip-${t.id}-riders`, url: `/?dir=${t.dir}`,
  }));
  res.json({ ok: true });
}));

app.delete("/api/trips/:id/join", rateLimit, auth, wrap(async (req, res) => {
  const t = await one("SELECT * FROM trips WHERE id = ?", req.params.id);
  if (!t) return res.status(404).json({ error: "Ese viaje ya no existe." });
  const r = await one("SELECT name FROM riders WHERE trip_id = ? AND device_id = ?", t.id, req.device);
  if (!r) return res.json({ ok: true });
  await q("DELETE FROM riders WHERE trip_id = ? AND device_id = ?", t.id, req.device);
  await safely(notifyDevice(t.owner_device, {
    title: `${r.name} ya no va`,
    body: `Se ha liberado una plaza en tu viaje ${DIR_TEXT[t.dir]} de ${dayWord(t.date)} a las ${t.time}.`,
    tag: `trip-${t.id}-riders`, url: `/?dir=${t.dir}`,
  }));
  res.json({ ok: true });
}));

// Suscripción a notificaciones y preferencias
app.post("/api/subscription", rateLimit, auth, wrap(async (req, res) => {
  const s = req.body?.subscription;
  const endpoint = typeof s?.endpoint === "string" ? s.endpoint : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !s.keys?.p256dh || !s.keys?.auth) {
    return res.status(400).json({ error: "Suscripción no válida." });
  }
  await q(`INSERT INTO subscriptions (endpoint, device_id, keys_json, notify_ida, notify_vuelta, created_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(endpoint) DO UPDATE SET device_id=excluded.device_id, keys_json=excluded.keys_json,
           notify_ida=excluded.notify_ida, notify_vuelta=excluded.notify_vuelta`,
    endpoint, req.device, JSON.stringify({ p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }),
    req.body.ida === false ? 0 : 1, req.body.vuelta === false ? 0 : 1, Date.now());
  res.json({ ok: true });
}));

app.delete("/api/subscription", rateLimit, auth, wrap(async (req, res) => {
  await q("DELETE FROM subscriptions WHERE device_id = ?", req.device);
  res.json({ ok: true });
}));

app.get("/healthz", async (req, res) => {
  try {
    await ensureReady();
    await q("SELECT 1");
    res.json({ ok: true, push: push.enabled });
  } catch (err) {
    console.error("[healthz]", err);
    res.status(500).json({ ok: false, error: explain(err) });
  }
});

// Archivos de la app (en Vercel los sirve directamente su CDN desde public/).
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    if (/(sw\.js|\.html|\.webmanifest)$/.test(file)) res.set("Cache-Control", "no-cache");
  },
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno. Inténtalo de nuevo en un momento.", detail: explain(err) });
});

export default app;
export { app, db };

if (!process.env.VERCEL && process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`La Felipa ⇄ Albacete escuchando en el puerto ${PORT}`));
}
