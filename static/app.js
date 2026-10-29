/* Lab kit app: browser side.
 * Every action is saved on this device first (the queue), then sent to the
 * server when a connection is available. The server checks each action and is
 * the master copy. Reading the label happens on the device, so it works offline. */
(function () {
  "use strict";

  // ---------- small helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEYS = { session: "kit.session", snap: "kit.snap", queue: "kit.queue",
                 rejected: "kit.rejected", device: "kit.device" };
  const SHIFT_FALLBACK_HOURS = 8;

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { flash("This device is out of storage. Send saved actions before you continue.", "err"); return false; }
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function deviceId() {
    let id = load(KEYS.device, null);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      save(KEYS.device, id);
    }
    return id;
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows PC";
    return "Browser";
  }

  // ---------- state ----------
  const S = {
    session: load(KEYS.session, null),   // { user, protocol, protocol_quantities, today, shiftEnd }
    snap: load(KEYS.snap, { boxes: [], savedAt: null }),
    queue: load(KEYS.queue, []),         // actions not yet confirmed by the server
    rejected: load(KEYS.rejected, []),   // actions the server refused, for a person to review
    online: navigator.onLine,
    mode: "receive",
    tab: "scan",
    view: { sheetFilter: "" },
    message: null,
    reader: null,
  };

  function setMessage(text, kind) { S.message = { text, kind }; }
  function flash(text, kind) { setMessage(text, kind); render(); }

  // ---------- server calls ----------
  async function api(path, opts) {
    const o = Object.assign({ credentials: "same-origin", headers: {} }, opts || {});
    if (o.body && typeof o.body !== "string") {
      o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers);
      o.body = JSON.stringify(o.body);
    }
    const res = await fetch(path, o);
    let data = null;
    try { data = await res.json(); } catch (e) { /* csv or empty */ }
    return { status: res.status, data };
  }

  // Works out whether the server is reachable and whether the sign-in still holds.
  async function checkConnection() {
    try {
      const r = await api("/api/me");
      S.online = true;
      if (r.status === 200) {
        S.session = Object.assign({}, S.session, r.data, {
          shiftEnd: Date.now() + SHIFT_FALLBACK_HOURS * 3600e3,
        });
        save(KEYS.session, S.session);
        return "in";
      }
      return "out";                       // server says sign in again
    } catch (e) {
      S.online = false;
      return "offline";
    }
  }

  async function refreshSnapshot() {
    if (!S.online || !S.session) return;
    const r = await api("/api/state");
    if (r.status === 200) {
      S.snap = { boxes: r.data.boxes, savedAt: new Date().toISOString() };
      save(KEYS.snap, S.snap);
      if (r.data.protocol) S.session.protocol = r.data.protocol;
      save(KEYS.session, S.session);
    }
  }

  // Sends the queue. Accepted items leave the queue; refused items go to "Needs attention".
  let flushing = false;
  async function flush() {
    if (flushing || !S.online || !S.session || S.queue.length === 0) return;
    flushing = true;
    try {
      const batch = S.queue.slice();
      const r = await api("/api/sync", { method: "POST", body: { events: batch } });
      if (r.status === 401) { flash("Sign in again to send the saved actions.", "err"); return; }
      if (r.status !== 200) return;
      const byId = {};
      r.data.results.forEach((x) => { byId[x.event_id] = x; });
      const sentIds = new Set(batch.map((e) => e.event_id));
      S.queue = S.queue.filter((e) => !sentIds.has(e.event_id));
      batch.forEach((e) => {
        const res = byId[e.event_id];
        if (res && res.result === "rejected") {
          S.rejected.unshift({ event: e, message: res.message, at: new Date().toISOString() });
        }
      });
      S.rejected = S.rejected.slice(0, 100);
      save(KEYS.queue, S.queue);
      save(KEYS.rejected, S.rejected);
      await refreshSnapshot();
    } catch (e) {
      S.online = false;
    } finally {
      flushing = false;
      render();
    }
  }

  // ---------- the box list shown on this device ----------
  // Server snapshot plus the actions still waiting on this device.
  function localBoxes() {
    const map = {};
    (S.snap.boxes || []).forEach((b) => { map[b.serial] = Object.assign({}, b, { pending: false }); });
    S.queue.forEach((e) => {
      if (e.action === "receive") {
        map[e.serial] = { serial: e.serial, kit_type: e.kit_type, product: e.product, lot: e.lot,
          expiry: e.expiry, quantity: e.quantity || 1, remaining_quantity: e.quantity || 1,
          status: "in_stock", used_for: "", received_by: S.session && S.session.user.email,
          received_at: e.device_time, updated_at: e.device_time, pending: true };
      } else if (e.action === "use" && map[e.serial]) {
        const remaining = Math.max(0, (map[e.serial].remaining_quantity || 1) - (e.amount || 1));
        Object.assign(map[e.serial], { remaining_quantity: remaining,
          status: remaining ? "in_stock" : "used",
          used_for: `${e.participant} | ${e.visit} (-${e.amount || 1})`, pending: true });
      } else if (e.action === "remove" && map[e.serial]) {
        Object.assign(map[e.serial], { status: "removed", used_for: `removed: ${e.reason}`, pending: true });
      }
    });
    return Object.values(map).sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));
  }

  // Checks an action on this device so obvious mistakes are caught before saving.
  // The server checks again when it receives the action.
  function checkLocal(ev) {
    const boxes = localBoxes();
    const box = boxes.find((b) => b.serial === ev.serial);
    const today = (S.session && S.session.today) || todayISO();
    if (ev.action === "receive") {
      if (!ev.serial) return "Scan the kit serial first";
      if (box) return `${ev.serial} is already received`;
      if (!ev.kit_type) return "Kit type is missing";
      if (!ev.lot) return "Lot is missing";
      if (!ev.expiry) return "Expiry date is missing";
      if (ev.expiry < today) return `Expired on ${ev.expiry}. Record it as removed instead`;
      return null;
    }
    if (ev.action === "use") {
      if (!box) return `${ev.serial || "This kit"} is not in stock. Receive it first`;
      if (box.status !== "in_stock") return `${ev.serial} is ${box.status} (${box.used_for || "no visit"})`;
      if (box.expiry && box.expiry < today) return `${ev.serial} expired on ${box.expiry}. Record it as removed`;
      const planned = ((S.session && S.session.protocol) || {})[box.kit_type] || [];
      if (!planned.includes(ev.visit) && !ev.reason) return `Kit ${box.kit_type} is not planned for ${ev.visit}. Give a reason`;
      if (!ev.participant) return "Enter the participant initials";
      const amount = Number(ev.amount || 1);
      if (!Number.isInteger(amount) || amount < 1) return "Deduction amount must be a whole number";
      if (amount > (box.remaining_quantity || 1)) return `Only ${box.remaining_quantity || 1} unit(s) remain`;
      return null;
    }
    if (ev.action === "remove") {
      if (!box) return `${ev.serial} is not in stock`;
      if (box.status !== "in_stock") return `${ev.serial} is ${box.status} (${box.used_for || "no visit"})`;
      if (!ev.reason) return "Give a reason for removing this kit";
      return null;
    }
    if (ev.action === "signoff") {
      if (!ev.participant || !ev.visit) return "Participant and visit are needed";
      return null;
    }
    return "Unknown action";
  }

  function enqueue(ev) {
    const err = checkLocal(ev);
    if (err) { flash(err, "err"); return false; }
    const full = Object.assign({ event_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      device: `${deviceName()} ${deviceId().slice(0, 6)}`, device_time: new Date().toISOString() }, ev);
    S.queue.push(full);
    if (!save(KEYS.queue, S.queue)) { S.queue.pop(); return false; }
    return true;
  }

  // ---------- sign in / out ----------
  async function signIn(email, password) {
    const r = await api("/api/login", { method: "POST", body: { email, password } });
    if (r.status !== 200) return r.data && r.data.error ? r.data.error : "Could not sign in";
    S.session = { user: r.data.user, protocol: null, today: todayISO(),
                  shiftEnd: Date.now() + SHIFT_FALLBACK_HOURS * 3600e3 };
    save(KEYS.session, S.session);
    await refreshSnapshot();
    await flush();
    return null;
  }

  async function signOut() {
    if (S.queue.length && !confirm(`${S.queue.length} saved action(s) are not sent yet. They stay on this device and send the next time you sign in here. Sign out?`)) return;
    try { await api("/api/logout", { method: "POST" }); } catch (e) { /* offline is fine */ }
    S.session = null;
    save(KEYS.session, null);
    render();
  }

  // Offline: the device keeps the signed-in user for one shift.
  function sessionValid() {
    if (!S.session) return false;
    if (S.online) return true;
    return S.session.shiftEnd && Date.now() < S.session.shiftEnd;
  }

  // ---------- rendering ----------
  function statusPill() {
    const pending = S.queue.length;
    const attention = S.rejected.length;
    const net = S.online ? '<span class="pill ok">Online</span>' : '<span class="pill warn">Offline</span>';
    const q = pending ? `<span class="pill">${pending} to send</span>` : '<span class="pill ok">All sent</span>';
    const a = attention ? `<span class="pill err">${attention} need attention</span>` : "";
    return `${net} ${q} ${a}`;
  }

  function messageHtml() {
    if (!S.message) return "";
    return `<div class="msg ${esc(S.message.kind)}" role="status">${esc(S.message.text)}</div>`;
  }

  function loginHtml(note) {
    return `
      <section class="card login">
        <h1>Lab kit tracker</h1>
        <p class="muted">Sign in with your lab account.</p>
        ${note ? `<div class="msg err">${esc(note)}</div>` : ""}
        <form id="loginForm" autocomplete="on">
          <label>Email<input name="email" type="email" autocapitalize="off" autocomplete="username" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary big" type="submit">Sign in</button>
        </form>
        ${S.online ? "" : '<p class="muted small">You are offline. Sign in needs a connection the first time on this device.</p>'}
      </section>`;
  }

  function optionsFor(list, selected) {
    return list.map((v) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(v)}</option>`).join("");
  }

  function scanHtml() {
    const modes = [["receive", "Receive"], ["use", "Use"], ["remove", "Remove"], ["signoff", "Sign off"]];
    const seg = modes.map(([k, l]) => `<button class="${S.mode === k ? "on" : ""}" data-mode="${k}">${l}</button>`).join("");
    const protocol = (S.session && S.session.protocol) || {};
    const allVisits = [...new Set(Object.values(protocol).flat())];
    const boxes = localBoxes();
    let form = "";

    if (S.mode === "receive") {
      form = `
        <form id="receiveForm" class="stack">
          <label>Kit serial (from the scanner)<input name="serial" inputmode="text" autocomplete="off" placeholder="Scan the serial" required></label>
          <div class="row2">
            <label>Kit type<input name="kit_type" maxlength="2" placeholder="A" required></label>
            <label>Lot<input name="lot" placeholder="TKDA0215-…" required></label>
          </div>
          <label>Expiry date<input name="expiry" type="date" required></label>
          <label>Product / protocol<input name="product" placeholder="Kit Type A · TAK-360-2002"></label>
          <div class="row2">
            <button type="button" class="big" id="openReader">Read label with camera</button>
            <button class="primary big" type="submit">Save receipt</button>
          </div>
        </form>
        <div id="readerBox"></div>`;
    } else if (S.mode === "use") {
      form = `
        <form id="useForm" class="stack">
          <label>Kit serial (from the scanner)<input name="serial" autocomplete="off" placeholder="Scan the box" required></label>
          <button type="button" class="big" id="openUseReader">Scan box with phone camera</button>
          <div id="readerBox"></div>
          <label>Participant initials<input name="participant" maxlength="4" autocapitalize="characters" placeholder="e.g. SM" required></label>
          <label>Visit<select name="visit">${optionsFor(allVisits, "")}<option value="__other">Other (give a reason)</option></select></label>
          <label>Reason (only if the visit is not planned for this kit)<input name="reason" placeholder="Reason"></label>
          <button class="primary big" type="submit">Record use</button>
        </form>`;
    } else if (S.mode === "remove") {
      form = `
        <form id="removeForm" class="stack">
          <label>Kit serial (from the scanner)<input name="serial" autocomplete="off" placeholder="Scan the box" required></label>
          <label>Reason<select name="reason"><option>Expired</option><option>Damaged</option><option>Recall</option><option>Other</option></select></label>
          <label>Details<input name="detail" placeholder="Optional details"></label>
          <button class="primary big" type="submit">Remove from stock</button>
        </form>`;
    } else {
      form = `
        <form id="signoffForm" class="stack">
          <label>Participant initials<input name="participant" maxlength="4" autocapitalize="characters" required></label>
          <label>Visit<select name="visit">${optionsFor(allVisits, "")}</select></label>
          <button class="primary big" type="submit">Sign off visit</button>
        </form>`;
    }

    const inStock = boxes.filter((b) => b.status === "in_stock").length;
    return `
      <div class="seg">${seg}</div>
      <p class="muted small">${inStock} kit(s) in stock on this device.</p>
      <div class="card">${form}</div>
      ${S.rejected.length ? attentionHtml() : ""}`;
  }

  function attentionHtml() {
    const items = S.rejected.slice(0, 20).map((r, i) => `
      <li><b>${esc(r.event.action)} ${esc(r.event.serial || "")}</b> ${esc(r.event.participant || "")}
        <div class="small">${esc(r.message)}</div>
        <button class="link" data-dismiss="${i}">Dismiss</button></li>`).join("");
    return `<div class="card warnbox"><h2>Needs attention</h2><p class="small muted">The server did not accept these. Fix them on the box, then record again.</p><ul class="list">${items}</ul></div>`;
  }

  function sheetHtml() {
    const boxes = localBoxes();
    const rows = boxes.map((b) => `
      <tr class="${b.pending ? "pending" : ""}">
        <td>${esc(b.serial)}${b.pending ? ' <span class="tag">to send</span>' : ""}</td>
        <td>${esc(b.kit_type)}</td><td>${esc(b.product)}</td><td>${esc(b.lot)}</td>
        <td>${esc(b.expiry)}</td><td>${esc(b.quantity || 1)}</td><td>${esc(b.remaining_quantity || 0)}</td>
        <td>${esc(b.status)}</td><td>${esc(b.used_for)}</td>
        <td>${esc(b.received_by)}</td></tr>`).join("");
    return `
      <div class="toolbar">
        <span class="muted small">${boxes.length} kit(s) on this device${S.snap.savedAt ? ` · last synced ${esc(new Date(S.snap.savedAt).toLocaleString())}` : ""}</span>
        <button id="exportCsv" class="big">Download Excel (CSV)</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Serial</th><th>Kit</th><th>Product</th><th>Lot</th><th>Expiry</th><th>Qty</th><th>Remaining</th><th>Status</th><th>Used for</th><th>Received by</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="10" class="muted">No kits yet</td></tr>'}</tbody>
      </table></div>`;
  }

  function auditHtml() {
    return `<div id="auditBox" class="muted">${S.online ? "Loading…" : "The audit trail is shown when you are online."}</div>`;
  }

  async function loadAudit() {
    if (!S.online) return;
    const r = await api("/api/audit");
    const box = $("#auditBox");
    if (!box) return;
    if (r.status !== 200) { box.textContent = "Could not load the audit trail."; return; }
    const rows = r.data.events.map((e) => `<tr><td>${esc(e.server_time)}</td><td>${esc(e.user)}</td>
      <td>${esc(e.action)}</td><td>${esc(e.serial)}</td><td>${esc(e.participant)} ${esc(e.visit)}</td>
      <td>${esc(e.result)}</td><td>${esc(e.message)}</td></tr>`).join("");
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>When (server)</th><th>User</th><th>Action</th>
      <th>Serial</th><th>Participant / visit</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function appHtml() {
    const tabs = [["scan", "Scan"], ["sheet", "Sheet"], ["audit", "Audit"]];
    const tabHtml = tabs.map(([k, l]) => `<button class="${S.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("");
    const body = S.tab === "scan" ? scanHtml() : S.tab === "sheet" ? sheetHtml() : auditHtml();
    return `
      <header class="top">
        <div><b>${esc(S.session.user.name)}</b> <span class="muted small">${esc(S.session.user.email)}</span></div>
        <button id="signOut" class="link">Sign out</button>
      </header>
      <div class="status">${statusPill()}</div>
      <nav class="tabs">${tabHtml}</nav>
      ${messageHtml()}
      <main>${body}</main>`;
  }

  function render() {
    const app = $("#app");
    if (!sessionValid()) {
      app.innerHTML = loginHtml(S.session && !S.online ? "Your offline shift has ended. Connect to the internet and sign in again." : "");
    } else {
      app.innerHTML = appHtml();
      if (S.tab === "audit") loadAudit();
    }
    bindPage();
    if (S.tab === "scan" && S.session) setTimeout(() => { const s = $("input[name=serial]"); if (s && !s.value) s.focus(); }, 50);
  }

  function formData(form) {
    const d = {};
    new FormData(form).forEach((v, k) => { d[k] = String(v).trim(); });
    return d;
  }

  function bindPage() {
    const login = $("#loginForm");
    if (login) login.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(login);
      const err = await signIn(d.email.toLowerCase(), d.password);
      if (err) { flash(err, "err"); return; }
      S.tab = "scan";
      render();
    });

    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; S.message = null; render(); }));
    document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { S.mode = b.dataset.mode; S.message = null; render(); }));
    document.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", () => {
      S.rejected.splice(+b.dataset.dismiss, 1); save(KEYS.rejected, S.rejected); render();
    }));
    const so = $("#signOut"); if (so) so.addEventListener("click", signOut);

    const rf = $("#receiveForm");
    if (rf) rf.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = formData(rf);
      const ev = { action: "receive", serial: d.serial, kit_type: d.kit_type.toUpperCase(), lot: d.lot.toUpperCase(),
                   expiry: d.expiry, product: d.product || `Kit Type ${d.kit_type.toUpperCase()}` };
      if (enqueue(ev)) { flash(`Received ${ev.serial}`, "ok"); after(); }
    });

    const uf = $("#useForm");
    if (uf) uf.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = formData(uf);
      const box = localBoxes().find((b) => b.serial === d.serial);
      let visit = d.visit; let reason = d.reason;
      if (visit === "__other") { if (!reason) { flash("Give a reason for this use", "err"); return; } visit = "Other"; }
      const planned = box ? ((S.session.protocol || {})[box.kit_type] || []) : [];
      if (box && !planned.includes(visit) && !reason) { flash(`Kit ${box.kit_type} is not planned for ${visit}. Give a reason`, "err"); return; }
      const quantities = (S.session && S.session.protocol_quantities) || {};
      const amount = Number((quantities[box && box.kit_type] || {})[visit] || 1);
      const ev = { action: "use", serial: d.serial, participant: d.participant.toUpperCase(), visit, reason, amount };
      if (enqueue(ev)) { flash(`Recorded ${amount} unit(s) from ${ev.serial} for ${ev.participant}, ${ev.visit}`, "ok"); after(); }
    });

    const mf = $("#removeForm");
    if (mf) mf.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = formData(mf);
      const detail = d.detail ? `: ${d.detail}` : "";
      const ev = { action: "remove", serial: d.serial, reason: `${d.reason}${detail}` };
      if (enqueue(ev)) { flash(`Removed ${ev.serial}`, "ok"); after(); }
    });

    const sf = $("#signoffForm");
    if (sf) sf.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = formData(sf);
      const ev = { action: "signoff", participant: d.participant.toUpperCase(), visit: d.visit };
      if (enqueue(ev)) { flash(`Signed off ${ev.participant}, ${ev.visit}`, "ok"); after(); }
    });

    const ro = $("#openReader"); if (ro) ro.addEventListener("click", openReader);
    const uro = $("#openUseReader"); if (uro) uro.addEventListener("click", () => openReader("use"));
    const ex = $("#exportCsv"); if (ex) ex.addEventListener("click", exportCsvLocal);
  }

  function after() {
    // Show the saved message, then try to send in the background.
    render();
    flush();
  }

  // ---------- Excel (CSV) built on this device, so it works offline ----------
  function exportCsvLocal() {
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [["Kit serial", "Kit type", "Product", "Lot", "Expiry", "Quantity", "Remaining", "Status", "Used for", "Received by", "Received at", "Waiting to send"]]
      .concat(localBoxes().map((b) => [b.serial, b.kit_type, b.product, b.lot, b.expiry,
        b.quantity || 1, b.remaining_quantity || 0, b.status, b.used_for, b.received_by,
        b.received_at, b.pending ? "yes" : ""]));
    const csv = "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `lab-kits-${todayISO()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- camera + on-device reading ----------
  function openReader(target = "receive") {
    const box = $("#readerBox");
    if (!box) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      box.innerHTML = '<div class="msg err">The camera is not available here. Type the fields by hand.</div>';
      return;
    }
    box.innerHTML = `
      <div class="card reader">
        <p class="small muted">Hold the label flat and level, about 20 cm away, in good light. Keep it still.</p>
        <video id="cam" playsinline muted autoplay></video>
        <canvas id="snap" hidden></canvas>
        <div class="row2">
          <button id="readNow" class="primary big">Read label</button>
          <button id="closeReader" class="big">Close camera</button>
        </div>
        <label>Or take a label photo<input id="labelPhoto" type="file" accept="image/*" capture="environment"></label>
        <div id="readOut" class="small"></div>
      </div>`;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const video = mobile ? { facingMode: { exact: "environment" } } : { facingMode: "user" };
    navigator.mediaDevices.getUserMedia({ video, audio: false })
      .then((stream) => {
        S.reader = { stream };
        const v = $("#cam");
        if (v) { v.srcObject = stream; v.play().catch(() => {}); }
      })
      .catch(() => { $("#readOut").innerHTML = '<span class="err">Camera permission was refused. Allow it in Settings, then try again.</span>'; });
    $("#readNow").addEventListener("click", readNow);
    $("#closeReader").addEventListener("click", closeReader);
    $("#labelPhoto").addEventListener("change", (e) => readPhoto(e.target.files[0]));
  }

  function closeReader() {
    if (S.reader && S.reader.stream) S.reader.stream.getTracks().forEach((t) => t.stop());
    S.reader = null;
    const box = $("#readerBox"); if (box) box.innerHTML = "";
  }

  async function readBarcode(video) {
    if (!("BarcodeDetector" in window)) return "";
    try {
      const formats = ["code_128", "ean_13", "ean_8", "itf", "code_39", "qr_code"];
      const detector = new window.BarcodeDetector({ formats });
      const found = await detector.detect(video);
      return found.length ? String(found[0].rawValue || "").trim() : "";
    } catch (e) {
      return "";
    }
  }

  let ocrWorker = null;
  async function getOcr() {
    if (ocrWorker) return ocrWorker;
    if (!window.Tesseract) {
      await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/vendor/tesseract/tesseract.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    }
    ocrWorker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: "/vendor/tesseract/worker.min.js",
      corePath: "/vendor/tesseract-core/",
      langPath: "/vendor/lang/",
      gzip: true,
    });
    return ocrWorker;
  }

  // Rotates, crops, enlarges, and contrast-stretches the label before OCR.
  function prepared(source, deg, scale, crop = 1) {
    const src = document.createElement("canvas");
    const vw = source.videoWidth || source.width;
    const vh = source.videoHeight || source.height;
    const swap = deg === 90 || deg === 270;
    const cw = vw * crop, ch = vh * crop;
    src.width = swap ? ch : cw; src.height = swap ? cw : ch;
    const sctx = src.getContext("2d");
    sctx.translate(src.width / 2, src.height / 2);
    sctx.rotate((deg * Math.PI) / 180);
    sctx.drawImage(source, -cw / 2, -ch / 2, cw, ch);
    const out = document.createElement("canvas");
    out.width = src.width * scale; out.height = src.height * scale;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.drawImage(src, 0, 0, out.width, out.height);
    const img = octx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
      if (g < lo) lo = g; if (g > hi) hi = g;
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) / span) * 255));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  function mergeParsed(current, next) {
    if (!current) return next;
    return {
      serial: current.serial || next.serial,
      kit_type: current.kit_type || next.kit_type,
      protocol: current.protocol || next.protocol,
      lot: current.lot || next.lot,
      expiry: current.expiry || next.expiry,
      visits: current.visits.length ? current.visits : next.visits,
      problems: [...new Set([...(current.problems || []), ...(next.problems || [])])],
    };
  }

  async function readNow() {
    const video = $("#cam");
    const out = $("#readOut");
    if (!video || !video.videoWidth) { out.textContent = "Wait for the camera to show the label."; return; }
    const btn = $("#readNow"); btn.disabled = true;
    let best = null;
    try {
      const barcode = await readBarcode(video);
      const worker = await getOcr();
      const score = (p) => (p.serial ? 1 : 0) + (p.kit_type ? 1 : 0) +
        (p.lot ? 1 : 0) + (p.expiry ? 1 : 0) + (p.visits.length ? 1 : 0);
      const tries = [[0, 3, 0.8], [90, 3, 0.8], [180, 3, 0.8], [270, 3, 0.8],
                     [0, 3, 1], [90, 2, 1], [180, 2, 1], [270, 2, 1]];
      for (let i = 0; i < tries.length; i++) {
        const [deg, scale, crop] = tries[i];
        out.textContent = `Reading… (${i + 1} of ${tries.length})`;
        const { data } = await worker.recognize(prepared(video, deg, scale, crop));
        const parsed = window.LabelReader.parseLabel(data.text);
        best = { parsed: mergeParsed(best && best.parsed, parsed), deg, scale };
        if (score(best.parsed) === 5) break;
      }
      if (barcode) best.parsed.serial = barcode;
    } catch (e) {
      out.innerHTML = '<span class="err">Reading failed on this device. Type the fields by hand.</span>';
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    fillFromReading(best.parsed, S.mode);
  }

  async function readPhoto(file) {
    const out = $("#readOut");
    if (!file || !out) return;
    out.textContent = "Reading photo…";
    try {
      const worker = await getOcr();
      const image = typeof createImageBitmap === "function"
        ? await createImageBitmap(file)
        : await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = URL.createObjectURL(file);
          });
      let best = null;
      const tries = [[0, 3, 0.8], [90, 3, 0.8], [180, 3, 0.8], [270, 3, 0.8],
                     [0, 3, 1], [90, 2, 1], [180, 2, 1], [270, 2, 1]];
      const score = (p) => (p.serial ? 1 : 0) + (p.kit_type ? 1 : 0) +
        (p.lot ? 1 : 0) + (p.expiry ? 1 : 0) + (p.visits.length ? 1 : 0);
      for (let i = 0; i < tries.length; i++) {
        out.textContent = `Reading photo… (${i + 1} of ${tries.length})`;
        const [deg, scale, crop] = tries[i];
        const { data } = await worker.recognize(prepared(image, deg, scale, crop));
        const parsed = window.LabelReader.parseLabel(data.text);
        best = mergeParsed(best, parsed);
        if (score(best) >= 5) break;
      }
      if (image.close) image.close();
      fillFromReading(best || window.LabelReader.parseLabel(""), S.mode);
    } catch (e) {
      out.innerHTML = '<span class="err">Could not read that photo. Take a closer, sharper photo with the label upright.</span>';
    }
  }

  function fillFromReading(p, target = "receive") {
    const f = target === "use" ? $("#useForm") : $("#receiveForm");
    if (!f) return;
    if (p.serial) f.serial.value = p.serial;
    if (target === "use") {
      $("#readOut").innerHTML = p.serial
        ? '<span class="ok">Serial captured. Select the visit and record use.</span>'
        : '<span class="err">Serial not detected. Move closer and try again.</span>';
      return;
    }
    if (p.kit_type) f.kit_type.value = p.kit_type;
    if (p.lot) f.lot.value = p.lot;
    if (p.expiry) f.expiry.value = p.expiry;
    if (p.protocol || p.kit_type) f.product.value = `Kit Type ${p.kit_type || "?"}${p.protocol ? " · " + p.protocol : ""}`;
    const issues = window.LabelReader.checkFields(p, (S.session && S.session.today) || todayISO());
    const visits = p.visits.length ? `Visit(s) on the box: ${p.visits.join(", ")}.` : "";
    const check = issues.length
      ? `<span class="err">Please check: ${issues.map(esc).join(", ")}.</span>`
      : '<span class="ok">Read all fields. Check them against the box, then save.</span>';
    $("#readOut").innerHTML = `${check} ${esc(visits)}`;
  }

  // ---------- boot ----------
  async function boot() {
    // Show the saved screen straight away, then check the connection.
    render();
    const state = await checkConnection();
    if (state === "in") {
      await refreshSnapshot();
      await flush();
    } else if (state === "out") {
      S.session = null; save(KEYS.session, null);
    }
    render();
  }

  window.addEventListener("online", () => { S.online = true; boot(); });
  window.addEventListener("offline", () => { S.online = false; render(); });
  setInterval(() => { if (S.session && S.online) flush(); }, 15000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  boot();
})();
