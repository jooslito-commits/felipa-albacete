(() => {
  "use strict";
  const PLACES = { ida: "Salida de La Felipa", vuelta: "Salida de Albacete" };
  const $ = s => document.querySelector(s);
  const list = $("#list"), stateEl = $("#state");
  let trips = [], loaded = false, userPicked = false, pendingJoin = null, config = { pushEnabled: false };
  let dir = new URLSearchParams(location.search).get("dir") === "vuelta" ? "vuelta" : "ida";
  if (new URLSearchParams(location.search).has("dir")) userPicked = true;

  // ---------- Almacenamiento local ----------
  const store = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  function rand(n) {
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Identificador anónimo de este móvil (sin cuentas ni datos personales).
  let deviceId = store.get("fa_device"), deviceSecret = store.get("fa_secret");
  if (!deviceId || !deviceSecret) {
    deviceId = rand(18); deviceSecret = rand(32);
    store.set("fa_device", deviceId); store.set("fa_secret", deviceSecret);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId, "X-Device-Secret": deviceSecret },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Algo ha fallado. Prueba otra vez.");
    return data;
  }

  // ---------- Utilidades ----------
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const isoDate = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => isoDate(new Date());
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2800);
  }
  function dayLabel(iso) {
    const d = new Date(iso + "T12:00:00"), t = new Date(); t.setHours(12, 0, 0, 0);
    const diff = Math.round((d - t) / 86400000);
    if (diff === 0) return "Hoy";
    if (diff === 1) return "Mañana";
    const s = d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const isPast = t => new Date(t.date + "T" + t.time + ":00").getTime() < Date.now() - 30 * 60000;

  // ---------- Pintar viajes ----------
  function render() {
    const count = d => trips.filter(t => t.dir === d && !isPast(t)).length;
    const otherDir = dir === "ida" ? "vuelta" : "ida";
    if (!userPicked && loaded && !count(dir) && count(otherDir)) dir = otherDir;
    document.querySelectorAll(".dir").forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.dir === dir));
      const n = count(b.dataset.dir);
      b.querySelector(".n").textContent = !loaded ? "" : n ? (n === 1 ? "1 viaje" : n + " viajes") : "Sin viajes";
    });
    if (!loaded) return;
    const visible = trips.filter(t => t.dir === dir && !isPast(t));
    if (!visible.length) {
      const other = count(dir === "ida" ? "vuelta" : "ida");
      list.innerHTML = `<div class="empty">Todavía no hay viajes ${dir === "ida" ? "hacia Albacete" : "hacia La Felipa"}.<br>${
        other ? `Hay ${other === 1 ? "1 viaje" : other + " viajes"} en el otro sentido: pulsa «${dir === "ida" ? "A La Felipa" : "A Albacete"}» arriba.`
              : "Si vas en coche, ¡publícalo!"}</div>`;
      return;
    }
    let html = "", lastDay = "";
    for (const t of visible) {
      if (t.date !== lastDay) { html += `<h2 class="day">${esc(dayLabel(t.date))}</h2>`; lastDay = t.date; }
      const taken = t.riders.length, free = Math.max(0, t.seats - taken);
      let seats = "";
      for (let i = 0; i < t.seats; i++) seats += `<span class="seat ${i < taken ? "taken" : ""}" aria-hidden="true"></span>`;
      const tag = t.mine ? `<span class="tag mine">Tu viaje</span>`
        : free ? `<span class="tag">${free} ${free === 1 ? "plaza libre" : "plazas libres"}</span>`
        : `<span class="tag full">Completo</span>`;
      let act;
      if (t.mine) act = `<span class="hint">Es tu coche: los vecinos verán aquí el botón «Me apunto».</span><button class="btn warn" data-del="${esc(t.id)}">Cancelar mi viaje</button>`;
      else if (t.joined) act = `<button class="btn ghost" data-leave="${esc(t.id)}">Ya no voy</button>`;
      else act = `<button class="btn go" data-join="${esc(t.id)}" ${free ? "" : "disabled"}>Me apunto</button>`;
      html += `<article class="trip">
        <div class="time cond">${esc(t.time)}</div>
        <div class="who">Conduce ${esc(t.driver)}</div>
        <div class="where">Recogida: <strong>${esc(t.place || PLACES[t.dir])}</strong></div>
        <div class="seats">${seats} ${tag}</div>
        ${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}
        ${taken ? `<div class="riders">Van: ${t.riders.map(esc).join(", ")}${t.mine ? ` · te darán ${taken * 2} €` : ""}</div>` : ""}
        <div class="actions">${act}</div>
      </article>`;
    }
    list.innerHTML = html;
  }

  async function load() {
    try {
      const data = await api("GET", "/api/trips");
      trips = data.trips; loaded = true;
      stateEl.textContent = ""; stateEl.className = "status";
    } catch (e) {
      stateEl.textContent = navigator.onLine ? "No se han podido cargar los viajes. Reintentando…" : "Sin conexión. Se actualizará al volver la cobertura.";
      stateEl.className = "status err";
    }
    render();
  }

  document.querySelectorAll(".dir").forEach(b => b.addEventListener("click", () => { userPicked = true; dir = b.dataset.dir; render(); }));

  list.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.join) {
        pendingJoin = b.dataset.join;
        $("#jName").value = store.get("fa_name");
        $("#joinDlg").showModal(); $("#jName").focus();
      } else if (b.dataset.leave) {
        b.disabled = true;
        await api("DELETE", `/api/trips/${encodeURIComponent(b.dataset.leave)}/join`);
        toast("Te has desapuntado"); await load();
      } else if (b.dataset.del) {
        if (!confirm("¿Cancelar este viaje? Avisaremos a quienes se hayan apuntado.")) return;
        b.disabled = true;
        await api("DELETE", `/api/trips/${encodeURIComponent(b.dataset.del)}`);
        toast("Viaje cancelado"); await load();
      }
    } catch (err) { toast(err.message); b.disabled = false; load(); }
  });

  $("#joinForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#jName").value.trim(); if (!name || !pendingJoin) return;
    store.set("fa_name", name);
    $("#joinDlg").close();
    try {
      await api("POST", `/api/trips/${encodeURIComponent(pendingJoin)}/join`, { name });
      toast("¡Apuntado! Lleva 2 € para quien conduce");
    } catch (err) { toast(err.message); }
    pendingJoin = null; load();
  });
  $("#jCancel").addEventListener("click", () => $("#joinDlg").close());

  // ---------- Publicar viaje ----------
  const dlg = $("#dlg");
  const syncPlace = () => { $("#fPlace").value = PLACES[$("#fDir").value]; };
  $("#fDir").addEventListener("change", syncPlace);
  $("#offer").addEventListener("click", () => {
    $("#fDir").value = dir; syncPlace();
    $("#fDate").value = today(); $("#fDate").min = today();
    const n = new Date(Date.now() + 30 * 60000); $("#fTime").value = pad(n.getHours()) + ":" + pad(n.getMinutes());
    $("#fName").value = store.get("fa_name"); $("#fNote").value = ""; $("#fStatus").textContent = "";
    dlg.showModal();
  });
  $("#cancel").addEventListener("click", () => dlg.close());
  $("#form").addEventListener("submit", async e => {
    e.preventDefault();
    const st = $("#fStatus"); st.className = "status";
    const data = {
      dir: $("#fDir").value, date: $("#fDate").value, time: $("#fTime").value,
      driver: $("#fName").value.trim(), seats: Number($("#fSeats").value),
      place: $("#fPlace").value.trim(), note: $("#fNote").value.trim(),
    };
    if (!data.date || !data.time || !data.driver) { st.textContent = "Rellena día, hora y nombre."; st.className = "status err"; return; }
    store.set("fa_name", data.driver);
    $("#save").disabled = true; st.textContent = "Publicando…";
    try {
      await api("POST", "/api/trips", data);
      dlg.close(); dir = data.dir; userPicked = true;
      toast("Viaje publicado. Avisaremos a los vecinos.");
      await load();
    } catch (err) { st.textContent = err.message; st.className = "status err"; }
    $("#save").disabled = false;
  });

  // ---------- Instalación ----------
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
  $("#installBtn").addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => {});
    installEvt = null; $("#installBtn").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; toast("App instalada"); });

  // ---------- Avisos (notificaciones push) ----------
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let swReg = null;

  function urlB64ToUint8Array(b64) {
    const padding = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  async function currentSub() { return swReg ? swReg.pushManager.getSubscription() : null; }
  async function saveSub(sub) {
    await api("POST", "/api/subscription", { subscription: sub.toJSON(), ida: $("#nIda").checked, vuelta: $("#nVuelta").checked });
  }
  async function refreshNotifUI() {
    const sub = await currentSub().catch(() => null);
    const on = Boolean(sub) && Notification.permission === "granted";
    $("#notifPanel").hidden = !on;
    $("#notifBtn").hidden = on || !config.pushEnabled;
    if (Notification.permission === "denied") {
      $("#notifBtn").hidden = false; $("#notifBtn").disabled = true;
      $("#notifBtn").textContent = "Avisos bloqueados en los ajustes del móvil";
    }
  }
  $("#notifBtn").addEventListener("click", async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Sin permiso no podemos avisarte"); return refreshNotifUI(); }
      let sub = await currentSub();
      if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(config.vapidPublicKey) });
      await saveSub(sub);
      toast("¡Avisos activados!");
    } catch (err) { toast("No se han podido activar los avisos"); console.error(err); }
    refreshNotifUI();
  });
  for (const id of ["#nIda", "#nVuelta"]) {
    $(id).addEventListener("change", async () => {
      store.set("fa_pref", JSON.stringify({ ida: $("#nIda").checked, vuelta: $("#nVuelta").checked }));
      const sub = await currentSub(); if (sub) saveSub(sub).then(() => toast("Preferencias guardadas")).catch(e => toast(e.message));
    });
  }
  $("#notifOff").addEventListener("click", async () => {
    const sub = await currentSub();
    try { await api("DELETE", "/api/subscription"); } catch {}
    if (sub) await sub.unsubscribe().catch(() => {});
    toast("Avisos desactivados"); refreshNotifUI();
  });
  try { const p = JSON.parse(store.get("fa_pref") || "{}"); if (p.ida === false) $("#nIda").checked = false; if (p.vuelta === false) $("#nVuelta").checked = false; } catch {}

  // ---------- Arranque ----------
  (async () => {
    try { config = await (await fetch("/api/config")).json(); } catch {}
    if ("serviceWorker" in navigator) {
      try {
        swReg = await navigator.serviceWorker.register("/sw.js");
        navigator.serviceWorker.addEventListener("message", e => { if (e.data?.type === "refresh") load(); });
      } catch (e) { console.error(e); }
    }
    if (isIOS && !isStandalone) $("#iosHelp").hidden = false;
    if (pushSupported && swReg && config.pushEnabled) {
      await refreshNotifUI();
      const sub = await currentSub().catch(() => null);
      if (sub && Notification.permission === "granted") saveSub(sub).catch(() => {}); // renueva la suscripción en el servidor
    }
  })();

  load();
  setInterval(load, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  window.addEventListener("online", load);
})();
