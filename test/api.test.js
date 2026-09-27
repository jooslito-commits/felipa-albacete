import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "felipa-"));
process.env.DATA_DIR = tmp;
const { app, db } = await import("../server.js");
let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => { server.close(); db.close?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

const dev = n => ({ "X-Device-Id": `dispositivo-prueba-${n}`, "X-Device-Secret": `secreto-de-prueba-numero-${n}` });
const call = async (method, url, headers, body) => {
  const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

test("flujo completo de un viaje", async () => {
  const conductor = dev("a"), p1 = dev("b"), p2 = dev("c");
  const c = await call("POST", "/api/trips", conductor, { dir: "ida", date: tomorrow, time: "08:15", seats: 1, driver: "Jose" });
  assert.equal(c.status, 201);
  const id = c.body.id;

  let l = await call("GET", "/api/trips", p1);
  assert.equal(l.body.trips.length, 1);
  assert.equal(l.body.trips[0].place, "Salida de La Felipa");
  assert.equal(l.body.trips[0].mine, false);

  assert.equal((await call("POST", `/api/trips/${id}/join`, conductor, { name: "Jose" })).status, 400, "no puede apuntarse a su viaje");
  assert.equal((await call("POST", `/api/trips/${id}/join`, p1, { name: "Ana" })).status, 200);
  assert.equal((await call("POST", `/api/trips/${id}/join`, p2, { name: "Luis" })).status, 409, "coche completo");

  l = await call("GET", "/api/trips", conductor);
  assert.deepEqual(l.body.trips[0].riders, ["Ana"]);
  assert.equal(l.body.trips[0].mine, true);

  assert.equal((await call("DELETE", `/api/trips/${id}`, p1)).status, 403, "solo el conductor cancela");
  assert.equal((await call("DELETE", `/api/trips/${id}/join`, p1)).status, 200);
  assert.equal((await call("POST", `/api/trips/${id}/join`, p2, { name: "Luis" })).status, 200, "plaza liberada");
  assert.equal((await call("DELETE", `/api/trips/${id}`, conductor)).status, 200);
  assert.equal((await call("GET", "/api/trips", p1)).body.trips.length, 0);
});

test("validaciones", async () => {
  assert.equal((await call("GET", "/api/trips", {})).status, 401);
  assert.equal((await call("POST", "/api/trips", dev("a"), { dir: "ida", date: "2020-01-01", time: "08:00", seats: 2, driver: "X" })).status, 400);
  assert.equal((await call("POST", "/api/trips", dev("a"), { dir: "x", date: tomorrow, time: "08:00", seats: 2, driver: "X" })).status, 400);
  assert.equal((await call("POST", "/api/trips", dev("a"), { dir: "ida", date: tomorrow, time: "08:00", seats: 9, driver: "X" })).status, 400);
  const wrong = { "X-Device-Id": "dispositivo-prueba-a", "X-Device-Secret": "otro-secreto-distinto-123" };
  assert.equal((await call("GET", "/api/trips", wrong)).status, 401, "no se puede suplantar otro móvil");
  assert.equal((await call("POST", "/api/subscription", dev("a"), { subscription: { endpoint: "http://x" } })).status, 400);
});

test("sirve la app instalable", async () => {
  for (const f of ["/", "/manifest.webmanifest", "/sw.js", "/app.js", "/icons/icon-512.png"]) {
    assert.equal((await fetch(base + f)).status, 200, f);
  }
  const cfg = await (await fetch(base + "/api/config")).json();
  assert.equal(cfg.pushEnabled, false, "sin VAPID_SUBJECT no hay avisos");
  assert.ok(cfg.vapidPublicKey.length > 40, "clave pública generada");
  const saved = await db.execute("SELECT value FROM settings WHERE key = 'vapid'");
  assert.equal(JSON.parse(saved.rows[0].value).publicKey, cfg.vapidPublicKey, "se guarda en la base de datos para reutilizarla");
});

test("dos personas a la vez por la última plaza: solo entra una", async () => {
  const c = await call("POST", "/api/trips", dev("d"), { dir: "vuelta", date: tomorrow, time: "19:00", seats: 1, driver: "Mari" });
  const [r1, r2, r3] = await Promise.all(["e", "f", "g"].map(n => call("POST", `/api/trips/${c.body.id}/join`, dev(n), { name: n })));
  assert.deepEqual([r1.status, r2.status, r3.status].sort(), [200, 409, 409]);
  const l = await call("GET", "/api/trips", dev("d"));
  assert.equal(l.body.trips.find(t => t.id === c.body.id).riders.length, 1);
});
