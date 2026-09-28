(() => {
  "use strict";
  const PLACES = { ida: "Salida de La Felipa", vuelta: "Salida de Albacete" };
  const $ = s => document.querySelector(s);
  const list = $("#list"), stateEl = $("#state");
  const FEE = 1.5; // aportación por reserva y trayecto
  const eur = n => n.toLocaleString("es-ES", { minimumFractionDigits: n % 1 ? 1 : 0, maximumFractionDigits: 2 }) + " €";
  let requests = [], forRequest = null;
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
    const countReq = d => requests.filter(r => r.dir === d && !isPast(r)).length;
    const any = d => count(d) + countReq(d);
    const otherDir = dir === "ida" ? "vuelta" : "ida";
    if (!userPicked && loaded && !any(dir) && any(otherDir)) dir = otherDir;
    document.querySelectorAll(".dir").forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.dir === dir));
      const n = count(b.dataset.dir), m = countReq(b.dataset.dir);
      const parts = [n ? (n === 1 ? "1 viaje" : n + " viajes") : "Sin viajes"];
      if (m) parts.push(m === 1 ? "1 busca viaje" : m + " buscan viaje");
      b.querySelector(".n").textContent = !loaded ? "" : parts.join(" · ");
    });
    if (!loaded) return;
    const visible = trips.filter(t => t.dir === dir && !isPast(t));
    const reqs = requests.filter(r => r.dir === dir && !isPast(r));
    let html = "", lastDay = "";
    if (!visible.length) {
      const other = any(otherDir);
      html += `<div class="empty">Todavía no hay viajes ${dir === "ida" ? "hacia Albacete" : "hacia La Felipa"}.<br>${
        reqs.length ? "Pero hay vecinos buscando viaje: míralos más abajo."
              : other ? `Hay novedades en el otro sentido: pulsa «${dir === "ida" ? "A La Felipa" : "A Albacete"}» arriba.`
              : "Si vas en coche, pulsa «Ofrezco mi coche». Si necesitas ir, pulsa «Busco viaje»."}</div>`;
    }
    for (const t of visible) {
      if (t.date !== lastDay) { html += `<h2 class="day">${esc(dayLabel(t.date))}</h2>`; lastDay = t.date; }
      const taken = t.taken, free = Math.max(0, t.seats - taken);
      let seats = "";
      for (let i = 0; i < t.seats; i++) seats += `<span class="seat ${i < taken ? "taken" : ""}" aria-hidden="true"></span>`;
      const tag = t.mine ? `<span class="tag mine">Tu viaje</span>`
        : free ? `<span class="tag">${free} ${free === 1 ? "plaza libre" : "plazas libres"}</span>`
        : `<span class="tag full">Completo</span>`;
      let act;
      if (t.mine) act = `<span class="hint">Es tu coche: los vecinos verán aquí el botón «Me apunto».</span><button class="btn warn" data-del="${esc(t.id)}">Cancelar mi viaje</button>`;
      else if (t.joined) act = `<span class="hint">Has reservado ${t.myPlaces === 1 ? "1 plaza" : t.myPlaces + " plazas"} · ${eur(FEE)} para quien conduce.</span><button class="btn ghost" data-leave="${esc(t.id)}">Ya no voy</button>`;
      else act = `<button class="btn go" data-join="${esc(t.id)}" ${free ? "" : "disabled"}>Me apunto</button>`;
      html += `<article class="trip">
        <div class="time cond">${esc(t.time)}</div>
        <div class="who">Conduce ${esc(t.driver)}</div>
        <div class="where">Recogida: <strong>${esc(t.place || PLACES[t.dir])}</strong></div>
        <div class="seats">${seats} ${tag}</div>
        ${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}
        ${taken ? `<div class="riders">Van: ${t.riders.map(r => esc(r.name) + (r.places > 1 ? ` (${r.places} plazas)` : "")).join(", ")}${t.mine ? ` · te darán ${eur(t.riders.length * FEE)}` : ""}</div>` : ""}
        <div class="actions">${act}</div>
      </article>`;
    }
    if (reqs.length) {
      html += `<h2 class="sub">Vecinos que buscan viaje</h2><p class="subhint">Si vas en coche a esa hora, pulsa «Yo te llevo»: se publica tu viaje y esa persona queda apuntada.</p>`;
      lastDay = "";
      for (const r of reqs) {
        if (r.date !== lastDay) { html += `<h3 class="day">${esc(dayLabel(r.date))}</h3>`; lastDay = r.date; }
        const act = r.mine
          ? `<span class="hint">Es tu petición: te avisaremos cuando alguien te lleve.</span><button class="btn warn" data-unreq="${esc(r.id)}">Ya no lo necesito</button>`
          : `<button class="btn go" data-take="${esc(r.id)}">Yo te llevo</button>`;
        html += `<article class="trip req">
          <div class="time cond">${esc(r.time)}</div>
          <div class="who">${esc(r.name)} busca viaje</div>
          <div class="where">Hora aproximada · ${r.dir === "ida" ? "a Albacete" : "a La Felipa"}</div>
          <div class="seats"><span class="reqtag">${r.places === 1 ? "1 plaza" : r.places + " plazas"}</span></div>
          ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
          <div class="actions">${act}</div>
        </article>`;
      }
    }
    list.innerHTML = html;
  }

  async function load() {
    try {
      const data = await api("GET", "/api/trips");
      trips = data.trips; requests = data.requests || []; loaded = true;
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
        const trip = trips.find(t => t.id === pendingJoin);
        const free = trip ? Math.max(1, trip.seats - trip.taken) : 1;
        const sel = $("#jPlaces");
        sel.innerHTML = Array.from({ length: free }, (_, i) => `<option value="${i + 1}">${i + 1} ${i ? "plazas" : "plaza"}</option>`).join("");
        $("#jPlacesRow").hidden = free < 2;
        updateJoinCost();
        $("#jName").value = store.get("fa_name");
        $("#joinDlg").showModal(); $("#jName").focus();
      } else if (b.dataset.take) {
        const r = requests.find(x => x.id === b.dataset.take);
        if (r) openOffer(r);
      } else if (b.dataset.unreq) {
        if (!confirm("¿Retirar tu petición de viaje?")) return;
        b.disabled = true;
        await api("DELETE", `/api/requests/${encodeURIComponent(b.dataset.unreq)}`);
        toast("Petición retirada"); await load();
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

  function updateJoinCost() {
    const n = Number($("#jPlaces").value || 1);
    $("#jCost").textContent = n === 1 ? `Recuerda llevar ${eur(FEE)} para quien conduce.` : `Recuerda llevar ${eur(FEE)} para quien conduce (en total por las ${n} plazas).`;
  }
  $("#jPlaces").addEventListener("change", updateJoinCost);

  $("#joinForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#jName").value.trim(); if (!name || !pendingJoin) return;
    const places = Number($("#jPlaces").value || 1);
    store.set("fa_name", name);
    $("#joinDlg").close();
    try {
      await api("POST", `/api/trips/${encodeURIComponent(pendingJoin)}/join`, { name, places });
      toast(places === 1 ? `¡Apuntado! Lleva ${eur(FEE)} para quien conduce` : `¡${places} plazas reservadas! Lleva ${eur(FEE)} para quien conduce`);
    } catch (err) { toast(err.message); }
    pendingJoin = null; load();
  });
  $("#jCancel").addEventListener("click", () => $("#joinDlg").close());

  // ---------- Publicar viaje ----------
  const dlg = $("#dlg");
  const syncPlace = () => { $("#fPlace").value = PLACES[$("#fDir").value]; };
  $("#fDir").addEventListener("change", syncPlace);
  function openOffer(r = null) {
    forRequest = r;
    $("#fFor").hidden = !r;
    $("#fDir").disabled = Boolean(r);
    $("#fDir").value = r ? r.dir : dir; syncPlace();
    $("#fDate").min = today();
    $("#fDate").value = r ? r.date : today();
    if (r) $("#fTime").value = r.time;
    else { const n = new Date(Date.now() + 30 * 60000); $("#fTime").value = pad(n.getHours()) + ":" + pad(n.getMinutes()); }
    const min = r ? r.places : 1;
    $("#fSeats").innerHTML = [1, 2, 3, 4].filter(n => n >= min).map(n => `<option ${n === Math.max(3, min) ? "selected" : ""}>${n}</option>`).join("");
    if (r) $("#fFor").textContent = `Vas a llevar a ${r.name} (${r.places === 1 ? "1 plaza" : r.places + " plazas"}), que quedará apuntada automáticamente. Puedes ajustar la hora y ofrecer más plazas para otros vecinos.`;
    $("#fName").value = store.get("fa_name"); $("#fNote").value = ""; $("#fStatus").textContent = "";
    $("#save").textContent = r ? "Publicar y llevarle" : "Publicar viaje";
    dlg.showModal();
  }
  $("#offer").addEventListener("click", () => openOffer());
  $("#cancel").addEventListener("click", () => dlg.close());
  $("#form").addEventListener("submit", async e => {
    e.preventDefault();
    const st = $("#fStatus"); st.className = "status";
    const data = {
      dir: $("#fDir").value, date: $("#fDate").value, time: $("#fTime").value,
      driver: $("#fName").value.trim(), seats: Number($("#fSeats").value),
      place: $("#fPlace").value.trim(), note: $("#fNote").value.trim(),
      fromRequest: forRequest ? forRequest.id : undefined,
    };
    if (!data.date || !data.time || !data.driver) { st.textContent = "Rellena día, hora y nombre."; st.className = "status err"; return; }
    store.set("fa_name", data.driver);
    $("#save").disabled = true; st.textContent = "Publicando…";
    try {
      await api("POST", "/api/trips", data);
      dlg.close(); dir = data.dir; userPicked = true;
      toast(forRequest ? `Viaje publicado. Hemos avisado a ${forRequest.name}.` : "Viaje publicado. Avisaremos a los vecinos.");
      forRequest = null;
      await load();
    } catch (err) { st.textContent = err.message; st.className = "status err"; }
    $("#save").disabled = false;
  });

  // ---------- Busco viaje ----------
  const seekDlg = $("#seekDlg");
  $("#seek").addEventListener("click", () => {
    $("#sDir").value = dir;
    $("#sDate").min = today(); $("#sDate").value = today();
    const n = new Date(Date.now() + 60 * 60000); $("#sTime").value = pad(n.getHours()) + ":00";
    $("#sName").value = store.get("fa_name"); $("#sNote").value = ""; $("#sPlaces").value = "1"; $("#sStatus").textContent = "";
    seekDlg.showModal();
  });
  $("#sCancel").addEventListener("click", () => seekDlg.close());
  $("#seekForm").addEventListener("submit", async e => {
    e.preventDefault();
    const st = $("#sStatus"); st.className = "status";
    const data = { dir: $("#sDir").value, date: $("#sDate").value, time: $("#sTime").value,
      name: $("#sName").value.trim(), places: Number($("#sPlaces").value), note: $("#sNote").value.trim() };
    if (!data.date || !data.time || !data.name) { st.textContent = "Rellena día, hora y nombre."; st.className = "status err"; return; }
    store.set("fa_name", data.name);
    $("#sSave").disabled = true; st.textContent = "Publicando…";
    try {
      await api("POST", "/api/requests", data);
      seekDlg.close(); dir = data.dir; userPicked = true;
      toast("Petición publicada. Avisaremos a los conductores.");
      await load();
    } catch (err) { st.textContent = err.message; st.className = "status err"; }
    $("#sSave").disabled = false;
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
