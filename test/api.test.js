import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "felipa-"));
process.env.DATA_DIR = tmp;
process.env.RATE_LIMIT = "1000";
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
  assert.deepEqual(l.body.trips[0].riders, [{ name: "Ana", places: 1 }]);
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


test("reservar varias plazas", async () => {
  const c = await call("POST", "/api/trips", dev("k"), { dir: "ida", date: tomorrow, time: "10:00", seats: 4, driver: "Carmen" });
  const id = c.body.id;
  assert.equal((await call("POST", `/api/trips/${id}/join`, dev("l"), { name: "Pili", places: 3 })).status, 200);
  const lleno = await call("POST", `/api/trips/${id}/join`, dev("m"), { name: "Juan", places: 2 });
  assert.equal(lleno.status, 409);
  assert.match(lleno.body.error, /Solo queda 1 plaza libre/);
  assert.equal((await call("POST", `/api/trips/${id}/join`, dev("l"), { name: "Pili", places: 1 })).status, 409, "no duplica la reserva");
  assert.equal((await call("POST", `/api/trips/${id}/join`, dev("m"), { name: "Juan", places: 5 })).status, 400);
  assert.equal((await call("POST", `/api/trips/${id}/join`, dev("m"), { name: "Juan", places: 1 })).status, 200);
  let t = (await call("GET", "/api/trips", dev("l"))).body.trips.find(x => x.id === id);
  assert.equal(t.taken, 4); assert.equal(t.myPlaces, 3);
  assert.deepEqual(t.riders, [{ name: "Pili", places: 3 }, { name: "Juan", places: 1 }]);
  await call("DELETE", `/api/trips/${id}/join`, dev("l"));
  t = (await call("GET", "/api/trips", dev("k"))).body.trips.find(x => x.id === id);
  assert.equal(t.taken, 1, "al anular se liberan las 3 plazas");
});

test("dos reservas a la vez que no caben juntas: solo entra una", async () => {
  const c = await call("POST", "/api/trips", dev("n"), { dir: "vuelta", date: tomorrow, time: "20:00", seats: 3, driver: "Paco" });
  const rs = await Promise.all([["o", 2], ["p", 2]].map(([d, n]) => call("POST", `/api/trips/${c.body.id}/join`, dev(d), { name: d, places: n })));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
});

test("busco viaje y «yo te llevo»", async () => {
  const pasajera = dev("q"), conductor = dev("r"), otro = dev("s");
  const r = await call("POST", "/api/requests", pasajera, { dir: "ida", date: tomorrow, time: "09:30", places: 2, name: "Lola", note: "voy al médico" });
  assert.equal(r.status, 201);
  let l = await call("GET", "/api/trips", conductor);
  const pet = l.body.requests.find(x => x.id === r.body.id);
  assert.equal(pet.places, 2); assert.equal(pet.mine, false);
  assert.equal((await call("GET", "/api/trips", pasajera)).body.requests.find(x => x.id === r.body.id).mine, true);

  assert.equal((await call("DELETE", `/api/requests/${r.body.id}`, otro)).status, 403, "solo quien la publicó la retira");
  const pocas = await call("POST", "/api/trips", conductor, { dir: "ida", date: tomorrow, time: "09:30", seats: 1, driver: "Juan", fromRequest: r.body.id });
  assert.equal(pocas.status, 400, "no caben 2 plazas en 1");
  assert.equal((await call("POST", "/api/trips", pasajera, { dir: "ida", date: tomorrow, time: "09:30", seats: 3, driver: "Lola", fromRequest: r.body.id })).status, 400, "no puede llevarse a sí misma");

  const t = await call("POST", "/api/trips", conductor, { dir: "ida", date: tomorrow, time: "09:15", seats: 3, driver: "Juan", fromRequest: r.body.id });
  assert.equal(t.status, 201); assert.equal(t.body.attached, true);
  l = await call("GET", "/api/trips", pasajera);
  assert.equal(l.body.requests.some(x => x.id === r.body.id), false, "la petición desaparece al tener viaje");
  const viaje = l.body.trips.find(x => x.id === t.body.id);
  assert.equal(viaje.joined, true); assert.equal(viaje.myPlaces, 2); assert.equal(viaje.taken, 2);

  const otra = await call("POST", "/api/trips", otro, { dir: "ida", date: tomorrow, time: "09:30", seats: 3, driver: "Pedro", fromRequest: r.body.id });
  assert.equal(otra.status, 409, "no se puede atender dos veces");

  const r2 = await call("POST", "/api/requests", pasajera, { dir: "vuelta", date: tomorrow, time: "14:00", places: 1, name: "Lola" });
  assert.equal((await call("DELETE", `/api/requests/${r2.body.id}`, pasajera)).status, 200);
  assert.equal((await call("POST", "/api/requests", pasajera, { dir: "vuelta", date: "2020-01-01", time: "14:00", name: "Lola" })).status, 400);
});
