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
    session: load(KEYS.session, null),   // { user, today, shiftEnd }
    snap: load(KEYS.snap, { boxes: [], savedAt: null }),   // also { config, acks } from the server
    queue: load(KEYS.queue, []),         // actions not yet confirmed by the server
    rejected: load(KEYS.rejected, []),   // actions the server refused, for a person to review
    online: navigator.onLine,
    mode: "receive",
    tab: "scan",
    view: { sheetFilter: "" },
    message: null,
    reading: false,           // a photo is being read
    readOut: "",              // reader status shown under the photo buttons
    labelProtocolId: null,    // protocol found printed on the label
    allocTouched: false,      // the person chose the allocation themselves
    skipRestore: false,       // the next render starts with empty forms
    alertsShowAll: false,     // dialog opened by hand, so it also lists acknowledged alerts
  };

  function setMessage(text, kind) { S.message = { text, kind }; }
  function flash(text, kind) { setMessage(text, kind); render(); }

  // ---------- studies, protocols and visits ----------
  function config() { return S.snap.config || { studies: [], settings: {}, overrides: [] }; }
  function allProtocols() {
    return config().studies.flatMap((s) => s.protocols.map((p) => Object.assign({ study: s.name }, p)));
  }
  function protocolById(id) { return allProtocols().find((p) => p.id === Number(id)) || null; }
  function protocolCode(id) { const p = protocolById(id); return p ? p.code : "Unallocated"; }
  function plannedVisits(protocol, kit) {
    return protocol ? protocol.visits.filter((v) => v.kit_types.includes(kit)) : [];
  }
  function protocolOptions(selected) {
    return config().studies.map((s) => `<optgroup label="${esc(s.name)}">${s.protocols.map((p) =>
      `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.code)}</option>`).join("")}</optgroup>`).join("");
  }

  // Where a newly received kit should go. The person can always change it.
  function suggestAllocation(kit) {
    const onLabel = protocolById(S.labelProtocolId);
    if (onLabel) return { value: String(onLabel.id), hint: `${onLabel.code} is printed on the label.` };
    if (!kit) return { value: "", hint: "" };
    const needing = allProtocols().filter((p) => plannedVisits(p, kit).length);
    if (needing.length === 1) {
      const names = plannedVisits(needing[0], kit).map((v) => v.name).join(", ");
      return { value: String(needing[0].id), hint: `Only ${needing[0].code} needs Kit ${kit} (${names}).` };
    }
    if (needing.length > 1) {
      return { value: "", hint: `Kit ${kit} is used by ${needing.map((p) => p.code).join(", ")}. Choose one, or keep it unallocated.` };
    }
    return { value: "unallocated", hint: `No protocol needs Kit ${kit} yet, so it goes to unallocated stock.` };
  }

  function syncReceiveForm() {
    const f = $("#receiveForm");
    if (!f) return;
    const kit = f.kit_type.value.trim().toUpperCase();
    const suggestion = suggestAllocation(kit);
    let hint = suggestion.hint;
    if (S.allocTouched) {
      const chosen = protocolById(f.protocol_id.value);
      hint = chosen && kit && !plannedVisits(chosen, kit).length ? `${chosen.code} has no visit planned for Kit ${kit}.` : "";
    } else {
      f.protocol_id.value = suggestion.value;
    }
    $("#allocHint").textContent = hint;
  }

  function fillVisitOptions(form, kit) {
    const protocol = protocolById(form.protocol_id.value);
    const visits = protocol ? protocol.visits : [];
    const planned = visits.filter((v) => v.kit_types.includes(kit));
    const others = visits.filter((v) => !v.kit_types.includes(kit));
    const option = (v) => `<option value="${esc(v.name)}">${esc(v.name)} · needs Kit ${esc(v.kit_types.join(", "))}</option>`;
    form.visit.innerHTML = [...planned, ...others].map(option).join("") +
      (form.id === "useForm" ? '<option value="__other">Other (give a reason)</option>' : "");
  }

  // Follows the serial: shows the kit, its protocol and the visits that need it.
  function syncUseForm() {
    const f = $("#useForm");
    if (!f) return;
    const box = localBoxes().find((b) => b.serial === f.serial.value.trim());
    if (box && f.dataset.serial !== box.serial) {
      f.dataset.serial = box.serial;
      const needing = allProtocols().filter((p) => plannedVisits(p, box.kit_type).length);
      const fallback = needing.length === 1 ? needing[0].id : "";
      f.protocol_id.value = box.protocol_id || fallback;
    }
    if (!box) delete f.dataset.serial;
    fillVisitOptions(f, box ? box.kit_type : "");
    const info = !box ? "" : `Kit ${box.kit_type}, expires ${box.expiry}, ${protocolCode(box.protocol_id)}.` +
      (box.protocol_id ? "" : " Choosing a protocol allocates it.");
    $("#kitInfo").textContent = info;
  }

  function syncSignoffForm() {
    const f = $("#signoffForm");
    if (f) fillVisitOptions(f, "");
  }

  function syncForms() { syncReceiveForm(); syncUseForm(); syncSignoffForm(); }

  // ---------- alerts ----------
  function activeAlerts() {
    return window.KitAlerts.computeAlerts(localBoxes(), config(), todayISO());
  }
  function isAcknowledged(alert) {
    const today = todayISO();
    return (S.snap.acks || []).some((a) => a.alert_key === alert.key && a.ack_date === today) ||
      S.queue.some((e) => e.action === "ack_alert" && e.alert_key === alert.key && e.ack_date === today);
  }
  function acknowledge(alert) {
    enqueue({ action: "ack_alert", alert_key: alert.key, ack_date: todayISO(), serial: alert.serial || "", reason: alert.text });
  }

  const ALERT_LABELS = { expired: "Expired", expiring: "Expiring soon", low: "Low stock" };

  function renderAlerts() {
    const dlg = $("#alertDialog");
    const all = activeAlerts();
    const shown = S.alertsShowAll ? all : all.filter((a) => !isAcknowledged(a));
    if (!shown.length) { if (dlg.open) dlg.close(); return; }
    const rows = shown.map((a) => `
      <div class="alert-row">
        <div><span class="kind ${a.kind}">${ALERT_LABELS[a.kind]}</span>${esc(a.text)}</div>
        ${isAcknowledged(a) ? '<span class="small muted">Acknowledged today</span>' : `<button data-ack="${esc(a.key)}">Acknowledge</button>`}
      </div>`).join("");
    const open = shown.filter((a) => !isAcknowledged(a));
    dlg.innerHTML = `
      <h2>Kit alerts (${shown.length})</h2>
      <p class="small muted">Acknowledging hides an alert for you until tomorrow. It returns until the kit is used, removed or restocked.</p>
      ${rows}
      <div class="actions">
        ${open.length ? '<button class="primary" id="ackAll">Acknowledge all</button>' : ""}
        <button id="closeAlerts">Close</button>
      </div>`;
    dlg.querySelectorAll("[data-ack]").forEach((b) => b.addEventListener("click", () => {
      const alert = all.find((a) => a.key === b.dataset.ack);
      if (alert) acknowledge(alert);
      alertsChanged();
    }));
    const ackAll = $("#ackAll", dlg);
    if (ackAll) ackAll.addEventListener("click", () => { open.forEach(acknowledge); alertsChanged(); });
    $("#closeAlerts", dlg).addEventListener("click", () => dlg.close());
    if (!dlg.open) dlg.showModal();
  }

  function alertsChanged() { renderAlerts(); render(); flush(); }

  // Opens the pop-up if this person has alerts they have not acknowledged today.
  function showNewAlerts() {
    if (!sessionValid() || $("#alertDialog").open) return;
    S.alertsShowAll = false;
    renderAlerts();
  }

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
      S.snap = { boxes: r.data.boxes, config: r.data.config, acks: r.data.acks, savedAt: new Date().toISOString() };
      save(KEYS.snap, S.snap);
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
          expiry: e.expiry, protocol_id: e.protocol_id || null,
          status: "in_stock", used_for: "", received_by: S.session && S.session.user.email,
          received_at: e.device_time, updated_at: e.device_time, pending: true };
      } else if (e.action === "use" && map[e.serial]) {
        Object.assign(map[e.serial], { status: "used", used_for: `${e.participant} | ${e.visit}`, pending: true });
      } else if (e.action === "allocate" && map[e.serial]) {
        Object.assign(map[e.serial], { protocol_id: e.protocol_id || null, pending: true });
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
      if (!ev.expiry) return "Expiry date is missing";
      if (ev.expiry < today) return `Expired on ${ev.expiry}. Record it as removed instead`;
      return null;
    }
    if (ev.action === "use") {
      if (!box) return `${ev.serial || "This kit"} is not in stock. Receive it first`;
      if (box.status !== "in_stock") return `${ev.serial} is ${box.status} (${box.used_for || "no visit"})`;
      if (box.expiry && box.expiry < today) return `${ev.serial} expired on ${box.expiry}. Record it as removed`;
      const protocol = protocolById(ev.protocol_id || box.protocol_id);
      if (!protocol) return `${ev.serial} is unallocated. Choose the protocol`;
      const planned = plannedVisits(protocol, box.kit_type).map((v) => v.name);
      if (!planned.includes(ev.visit) && !ev.reason) return `Kit ${box.kit_type} is not planned for ${ev.visit}. Give a reason`;
      if (!ev.participant) return "Enter the participant initials";
      return null;
    }
    if (ev.action === "remove") {
      if (!box) return `${ev.serial} is not in stock`;
      if (box.status !== "in_stock") return `${ev.serial} is ${box.status} (${box.used_for || "no visit"})`;
      if (!ev.reason) return "Give a reason for removing this kit";
      return null;
    }
    if (ev.action === "allocate") {
      if (!box) return `${ev.serial} is not in stock`;
      if (box.status !== "in_stock") return `${ev.serial} is ${box.status} (${box.used_for || "no visit"})`;
      return null;
    }
    if (ev.action === "signoff") {
      if (!ev.participant || !ev.visit) return "Participant and visit are needed";
      return null;
    }
    if (ev.action === "ack_alert") return null;
    return "Unknown action";
  }

  function withEventDetails(ev) {
    return Object.assign({ event_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      device: `${deviceName()} ${deviceId().slice(0, 6)}`, device_time: new Date().toISOString() }, ev);
  }

  function enqueue(ev) {
    const err = checkLocal(ev);
    if (err) { flash(err, "err"); return false; }
    S.queue.push(withEventDetails(ev));
    if (!save(KEYS.queue, S.queue)) { S.queue.pop(); return false; }
    return true;
  }

  // ---------- sign in / out ----------
  async function signIn(email, password) {
    const r = await api("/api/login", { method: "POST", body: { email, password } });
    if (r.status !== 200) return r.data && r.data.error ? r.data.error : "Could not sign in";
    S.session = { user: r.data.user, today: todayISO(),
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
    if ($("#alertDialog").open) $("#alertDialog").close();
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
    const count = activeAlerts().length;
    const alerts = count ? `<button class="pill err" id="openAlerts">${count} kit alert${count === 1 ? "" : "s"}</button>` : "";
    return `${net} ${q} ${a} ${alerts}`;
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

  // One way to read a label: take a picture or pick an image, then read that image.
  function photoHtml() {
    return `
      <div class="row2">
        <label class="filebtn">Take photo<input class="vh" data-photo type="file" accept="image/*" capture="environment"></label>
        <label class="filebtn">Upload image<input class="vh" data-photo type="file" accept="image/*"></label>
      </div>
      <div id="readOut" class="small hint" role="status">${S.readOut}</div>`;
  }

  function visitFields(requireReason) {
    return `
      <label>Protocol<select name="protocol_id"><option value="">Choose a protocol</option>${protocolOptions(null)}</select></label>
      <label>Visit<select name="visit"></select></label>
      ${requireReason ? '<label>Reason (only if the visit is not planned for this kit)<input name="reason" placeholder="Reason"></label>' : ""}`;
  }

  function scanHtml() {
    const modes = [["receive", "Receive"], ["use", "Use"], ["remove", "Remove"], ["signoff", "Sign off"]];
    const seg = modes.map(([k, l]) => `<button class="${S.mode === k ? "on" : ""}" data-mode="${k}">${l}</button>`).join("");
    const boxes = localBoxes();
    let form = "";

    if (S.mode === "receive") {
      form = `
        <form id="receiveForm" class="stack" data-keep>
          ${photoHtml()}
          <label>Kit serial<input name="serial" inputmode="text" autocomplete="off" placeholder="Read from the photo or scan" required></label>
          <div class="row2">
            <label>Kit type<input name="kit_type" maxlength="2" autocapitalize="characters" autocomplete="off" placeholder="J" required></label>
            <label>Expiry date<input name="expiry" type="date" required></label>
          </div>
          <label>Allocate to<select name="protocol_id">
            <option value="">Choose a protocol</option>
            <option value="unallocated">Unallocated stock</option>
            ${protocolOptions(null)}</select></label>
          <div id="allocHint" class="small muted hint"></div>
          <label>Lot (optional)<input name="lot" autocomplete="off" placeholder="TKDA0215-…"></label>
          <input type="hidden" name="product">
          <button class="primary big" type="submit">Save receipt</button>
        </form>`;
    } else if (S.mode === "use") {
      form = `
        <form id="useForm" class="stack" data-keep>
          ${photoHtml()}
          <label>Kit serial<input name="serial" autocomplete="off" placeholder="Read from the photo or scan" required></label>
          <div id="kitInfo" class="small muted hint"></div>
          <label>Participant initials<input name="participant" maxlength="4" autocapitalize="characters" placeholder="e.g. SM" required></label>
          ${visitFields(true)}
          <button class="primary big" type="submit">Record use</button>
        </form>`;
    } else if (S.mode === "remove") {
      form = `
        <form id="removeForm" class="stack" data-keep>
          ${photoHtml()}
          <label>Kit serial<input name="serial" autocomplete="off" placeholder="Read from the photo or scan" required></label>
          <label>Reason<select name="reason"><option>Expired</option><option>Damaged</option><option>Recall</option><option>Other</option></select></label>
          <label>Details<input name="detail" placeholder="Optional details"></label>
          <button class="primary big" type="submit">Remove from stock</button>
        </form>`;
    } else {
      form = `
        <form id="signoffForm" class="stack" data-keep>
          <label>Participant initials<input name="participant" maxlength="4" autocapitalize="characters" required></label>
          ${visitFields(false)}
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

  // Stock by kit type: the quantity, where it is allocated and what expires next.
  function stockSummaryHtml(boxes) {
    const today = todayISO();
    const usable = boxes.filter((b) => window.KitAlerts.isUsable(b, today));
    const types = [...new Set(usable.map((b) => b.kit_type))].sort();
    const rows = types.map((kit) => {
      const kits = usable.filter((b) => b.kit_type === kit);
      const byProtocol = {};
      kits.forEach((b) => { const code = protocolCode(b.protocol_id); byProtocol[code] = (byProtocol[code] || 0) + 1; });
      const split = Object.keys(byProtocol).sort().map((code) => `${code}: ${byProtocol[code]}`).join(", ");
      const next = kits.map((b) => b.expiry).sort()[0];
      return `<tr><td>${esc(kit)}</td><td>${kits.length}</td><td>${esc(next)}</td><td>${esc(split)}</td></tr>`;
    }).join("");
    return `
      <h2>Usable stock by kit type</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Kit</th><th>Quantity</th><th>Next expiry</th><th>Allocation</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No usable kits</td></tr>'}</tbody>
      </table></div>`;
  }

  function allocationCell(b) {
    if (b.status !== "in_stock") return esc(protocolCode(b.protocol_id));
    return `<select data-allocate="${esc(b.serial)}" aria-label="Allocation for ${esc(b.serial)}">
      <option value="">Unallocated</option>${protocolOptions(b.protocol_id)}</select>`;
  }

  function sheetHtml() {
    const boxes = localBoxes();
    const filter = S.view.sheetFilter;
    const listed = boxes.filter((b) => !filter ||
      (filter === "unallocated" ? b.status === "in_stock" && !b.protocol_id : b.protocol_id === Number(filter)));
    const rows = listed.map((b) => `
      <tr class="${b.pending ? "pending" : ""}">
        <td>${esc(b.serial)}${b.pending ? ' <span class="tag">to send</span>' : ""}</td>
        <td>${esc(b.kit_type)}</td><td>${esc(b.expiry)}</td><td>${allocationCell(b)}</td>
        <td>${esc(b.status)}</td><td>${esc(b.used_for)}</td><td>${esc(b.lot)}</td>
        <td>${esc(b.received_by)}</td></tr>`).join("");
    const filterOptions = `<option value="">All kits</option>
      <option value="unallocated" ${filter === "unallocated" ? "selected" : ""}>Unallocated stock</option>
      ${protocolOptions(Number(filter))}`;
    return `
      ${stockSummaryHtml(boxes)}
      <div class="toolbar">
        <span class="muted small">${boxes.length} kit(s) on this device${S.snap.savedAt ? ` · last synced ${esc(new Date(S.snap.savedAt).toLocaleString())}` : ""}</span>
      </div>
      <button id="exportCsv" class="big">Download Excel (CSV)</button>
      <label style="margin-top:10px">Show<select id="sheetFilter">${filterOptions}</select></label>
      <div class="table-wrap"><table>
        <thead><tr><th>Serial</th><th>Kit</th><th>Expiry</th><th>Allocation</th><th>Status</th><th>Used for</th><th>Lot</th><th>Received by</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">No kits here</td></tr>'}</tbody>
      </table></div>`;
  }

  function adminHtml() {
    const settings = config().settings;
    const studies = config().studies;
    const offline = S.online ? "" : '<div class="msg err">Admin changes need a connection.</div>';
    const scopeOptions = `<option value="">All stock of this type</option>${protocolOptions(null)}`;
    const overrides = config().overrides.map((o) => `
      <li>Kit ${esc(o.kit_type)}, ${o.protocol_id ? esc(protocolCode(o.protocol_id)) : "all stock"}: alert at ${o.threshold} left
        <button class="link" data-clear-kit="${esc(o.kit_type)}" data-clear-protocol="${o.protocol_id}">Remove</button></li>`).join("");
    const tree = studies.map((s) => `
      <h3>${esc(s.name)}</h3>
      ${s.protocols.map((p) => `
        <div class="small"><b>${esc(p.code)}</b> <span class="muted">${esc(p.name)}</span></div>
        <ul class="schedule">${p.visits.map((v) => `
          <li>${esc(v.name)}${v.day === null ? "" : ` <span class="muted">(day ${v.day})</span>`}: Kit ${esc(v.kit_types.join(", "))}</li>`).join("")
          || '<li class="muted">No visits yet</li>'}</ul>`).join("") || '<p class="small muted">No protocols yet</p>'}`).join("");
    const studyOptions = studies.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    return `
      ${offline}
      <div class="card">
        <h2>Alert settings</h2>
        <form id="settingsForm" class="stack" data-keep>
          <label>Alert this many days before a kit expires<input name="expiry_days" type="number" min="0" inputmode="numeric" value="${esc(settings.expiry_days)}" required></label>
          <div class="row2">
            <label>Low stock: kits left of a type, all stock<input name="low_stock_total" type="number" min="0" inputmode="numeric" value="${esc(settings.low_stock_total)}" required></label>
            <label>Low stock: kits left of a type, per protocol<input name="low_stock_protocol" type="number" min="0" inputmode="numeric" value="${esc(settings.low_stock_protocol)}" required></label>
          </div>
          <button class="primary big" type="submit">Save alert settings</button>
        </form>
        <h3>Different low stock quantity for one kit type</h3>
        ${overrides ? `<ul class="list small">${overrides}</ul>` : '<p class="small muted">None. The quantities above apply to every kit type.</p>'}
        <form id="overrideForm" class="stack" data-keep>
          <div class="row2">
            <label>Kit type<input name="kit_type" maxlength="2" autocapitalize="characters" autocomplete="off" placeholder="J" required></label>
            <label>Alert at this many left<input name="threshold" type="number" min="0" inputmode="numeric" required></label>
          </div>
          <label>Applies to<select name="protocol_id">${scopeOptions}</select></label>
          <button class="big" type="submit">Save override</button>
        </form>
      </div>
      <div class="card">
        <h2>Studies, protocols and visits</h2>
        ${tree}
      </div>
      <div class="card">
        <h2>Add a study</h2>
        <form id="studyForm" class="stack" data-keep>
          <label>Study name<input name="name" autocomplete="off" required></label>
          <button class="big" type="submit">Add study</button>
        </form>
      </div>
      <div class="card">
        <h2>Add a protocol</h2>
        <form id="protocolForm" class="stack" data-keep>
          <label>Study<select name="study_id">${studyOptions}</select></label>
          <div class="row2">
            <label>Protocol code (as printed on the label)<input name="code" autocomplete="off" required></label>
            <label>Name (optional)<input name="name" autocomplete="off"></label>
          </div>
          <button class="big" type="submit">Add protocol</button>
        </form>
      </div>
      <div class="card">
        <h2>Add a visit</h2>
        <form id="visitForm" class="stack" data-keep>
          <label>Protocol<select name="protocol_id">${protocolOptions(null)}</select></label>
          <div class="row2">
            <label>Visit name<input name="name" autocomplete="off" placeholder="Visit 1" required></label>
            <label>Schedule day (optional)<input name="day" inputmode="text" autocomplete="off" placeholder="14"></label>
          </div>
          <label>Kit types needed<input name="kit_types" autocapitalize="characters" autocomplete="off" placeholder="J, K" required></label>
          <button class="big" type="submit">Add visit</button>
        </form>
      </div>`;
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
    const tabs = [["scan", "Scan"], ["sheet", "Sheet"], ["audit", "Audit"], ["admin", "Admin"]];
    const tabHtml = tabs.map(([k, l]) => `<button class="${S.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("");
    const body = S.tab === "scan" ? scanHtml() : S.tab === "sheet" ? sheetHtml()
      : S.tab === "admin" ? adminHtml() : auditHtml();
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

  // Rendering rebuilds the page, so keep what is typed in a form across it.
  function captureForms() {
    const kept = {};
    if (!S.skipRestore) {
      document.querySelectorAll("#app form[data-keep]").forEach((f) => {
        kept[f.id] = {};
        [...f.elements].forEach((el) => { if (el.name && el.type !== "file") kept[f.id][el.name] = el.value; });
      });
    }
    S.skipRestore = false;
    return kept;
  }

  function restoreForms(kept) {
    Object.keys(kept).forEach((id) => {
      const f = document.getElementById(id);
      if (!f) return;
      Object.keys(kept[id]).forEach((name) => { if (f.elements[name]) f.elements[name].value = kept[id][name]; });
    });
  }

  function render() {
    const app = $("#app");
    const kept = captureForms();
    if (!sessionValid()) {
      app.innerHTML = loginHtml(S.session && !S.online ? "Your offline shift has ended. Connect to the internet and sign in again." : "");
    } else {
      app.innerHTML = appHtml();
      if (S.tab === "audit") loadAudit();
    }
    // Visit lists depend on the protocol, so they are filled before the visit is restored.
    restoreForms(kept);
    syncForms();
    restoreForms(kept);
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
      showNewAlerts();
    });

    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; S.message = null; clearReading(); render(); }));
    document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { S.mode = b.dataset.mode; S.message = null; clearReading(); render(); }));
    document.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", () => {
      S.rejected.splice(+b.dataset.dismiss, 1); save(KEYS.rejected, S.rejected); render();
    }));
    const so = $("#signOut"); if (so) so.addEventListener("click", signOut);

    const oa = $("#openAlerts");
    if (oa) oa.addEventListener("click", () => { S.alertsShowAll = true; renderAlerts(); });

    document.querySelectorAll("[data-photo]").forEach((input) => input.addEventListener("change", () => readPhoto(input.files[0])));

    const rf = $("#receiveForm");
    if (rf) {
      rf.kit_type.addEventListener("input", syncReceiveForm);
      rf.protocol_id.addEventListener("change", () => { S.allocTouched = true; syncReceiveForm(); });
      rf.addEventListener("submit", (e) => {
        e.preventDefault();
        const d = formData(rf);
        if (!d.protocol_id) { flash("Choose a protocol, or keep the kit in unallocated stock", "err"); return; }
        const kit = d.kit_type.toUpperCase();
        const protocol = protocolById(d.protocol_id);
        const ev = { action: "receive", serial: d.serial, kit_type: kit, lot: d.lot.toUpperCase(), expiry: d.expiry,
                     product: d.product || `Kit Type ${kit}`, protocol_id: protocol ? protocol.id : null };
        if (!enqueue(ev)) return;
        // Stock counts change with every kit received, so a shipment only stops
        // for an alert when the kit itself is close to its expiry.
        const days = window.KitAlerts.daysUntil(ev.expiry, todayISO());
        saved(`Received ${ev.serial} into ${protocolCode(ev.protocol_id)}`, days <= config().settings.expiry_days);
      });
    }

    const uf = $("#useForm");
    if (uf) {
      uf.serial.addEventListener("input", syncUseForm);
      uf.protocol_id.addEventListener("change", syncUseForm);
      uf.addEventListener("submit", (e) => {
        e.preventDefault();
        const d = formData(uf);
        const box = localBoxes().find((b) => b.serial === d.serial);
        let visit = d.visit; const reason = d.reason;
        if (visit === "__other") { if (!reason) { flash("Give a reason for this use", "err"); return; } visit = "Other"; }
        const protocolId = Number(d.protocol_id) || null;
        const ev = { action: "use", serial: d.serial, participant: d.participant.toUpperCase(), visit, reason };
        const err = checkLocal(Object.assign({ protocol_id: protocolId }, ev));
        if (err) { flash(err, "err"); return; }
        // Using a kit from another protocol, or from unallocated stock, moves it there first.
        if (protocolId && box.protocol_id !== protocolId && !enqueue({ action: "allocate", serial: d.serial, protocol_id: protocolId })) return;
        if (enqueue(ev)) saved(`Recorded ${ev.serial} for ${ev.participant}, ${ev.visit}`, true);
      });
    }

    const mf = $("#removeForm");
    if (mf) mf.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = formData(mf);
      const detail = d.detail ? `: ${d.detail}` : "";
      const ev = { action: "remove", serial: d.serial, reason: `${d.reason}${detail}` };
      if (enqueue(ev)) saved(`Removed ${ev.serial}`, true);
    });

    const sf = $("#signoffForm");
    if (sf) sf.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = formData(sf);
      const protocol = protocolById(d.protocol_id);
      const visit = protocol && d.visit ? `${protocol.code}: ${d.visit}` : "";
      const ev = { action: "signoff", participant: d.participant.toUpperCase(), visit };
      if (enqueue(ev)) saved(`Signed off ${ev.participant}, ${ev.visit}`);
    });

    const sfo = $("#signoffForm");
    if (sfo) sfo.protocol_id.addEventListener("change", syncSignoffForm);

    const ex = $("#exportCsv"); if (ex) ex.addEventListener("click", exportCsvLocal);
    const filter = $("#sheetFilter");
    if (filter) filter.addEventListener("change", () => { S.view.sheetFilter = filter.value; render(); });
    document.querySelectorAll("[data-allocate]").forEach((sel) => sel.addEventListener("change", () => {
      const ev = { action: "allocate", serial: sel.dataset.allocate, protocol_id: Number(sel.value) || null };
      if (enqueue(ev)) saved(`${ev.serial} moved to ${protocolCode(ev.protocol_id)}`);
    }));

    bindAdmin();
  }

  // Admin changes apply to everyone, so they need the server to accept them first.
  async function adminSend(ev) {
    if (!S.online) { flash("Admin changes need a connection.", "err"); return; }
    let r;
    try {
      r = await api("/api/sync", { method: "POST", body: { events: [withEventDetails(ev)] } });
    } catch (e) {
      S.online = false;
      flash("Admin changes need a connection.", "err");
      return;
    }
    if (r.status !== 200) { flash(r.status === 401 ? "Sign in again." : "The server could not save that.", "err"); return; }
    const res = r.data.results[0];
    if (res.result !== "accepted") { flash(res.message, "err"); return; }
    await refreshSnapshot();
    setMessage(res.message, "ok");
    S.skipRestore = true;
    render();
  }

  function bindAdmin() {
    const onSubmit = (id, build) => {
      const f = document.getElementById(id);
      if (f) f.addEventListener("submit", (e) => { e.preventDefault(); adminSend(build(formData(f))); });
    };
    onSubmit("settingsForm", (d) => ({ action: "set_settings", settings: d }));
    onSubmit("overrideForm", (d) => Object.assign({ action: "set_override" }, d));
    onSubmit("studyForm", (d) => Object.assign({ action: "add_study" }, d));
    onSubmit("protocolForm", (d) => Object.assign({ action: "add_protocol" }, d));
    onSubmit("visitForm", (d) => Object.assign({ action: "add_visit" }, d));
    document.querySelectorAll("[data-clear-kit]").forEach((b) => b.addEventListener("click", () => {
      adminSend({ action: "set_override", kit_type: b.dataset.clearKit, protocol_id: Number(b.dataset.clearProtocol) || null, threshold: "" });
    }));
  }

  // Show the saved message with empty forms, then try to send in the background.
  function saved(text, checkAlerts) {
    setMessage(text, "ok");
    S.skipRestore = true;
    clearReading();
    render();
    flush();
    if (checkAlerts) showNewAlerts();
  }

  function clearReading() {
    S.readOut = "";
    S.labelProtocolId = null;
    S.allocTouched = false;
  }

  // ---------- Excel (CSV) built on this device, so it works offline ----------
  function exportCsvLocal() {
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [["Kit serial", "Kit type", "Expiry", "Study", "Protocol", "Lot", "Product", "Status", "Used for", "Received by", "Received at", "Waiting to send"]]
      .concat(localBoxes().map((b) => {
        const protocol = protocolById(b.protocol_id);
        return [b.serial, b.kit_type, b.expiry, protocol ? protocol.study : "", protocolCode(b.protocol_id),
          b.lot, b.product, b.status, b.used_for, b.received_by, b.received_at, b.pending ? "yes" : ""];
      }));
    const csv = "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `lab-kits-${todayISO()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- photo + on-device reading ----------
  function setReadOut(html) {
    S.readOut = html;
    const out = $("#readOut");
    if (out) out.innerHTML = html;
  }

  // Not every browser has this (iPhone Safari does not), so OCR still reads the serial there.
  async function readBarcode(image) {
    if (!("BarcodeDetector" in window)) return "";
    try {
      const formats = ["code_128", "ean_13", "ean_8", "itf", "code_39", "qr_code"];
      const detector = new window.BarcodeDetector({ formats });
      const found = await detector.detect(image);
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

  function maxOcrPixels() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 8e6 : 16e6;
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
    // A full-size phone photo enlarged is too big for a phone browser to draw.
    const fit = Math.min(1, Math.sqrt(maxOcrPixels() / (src.width * src.height * scale * scale)));
    const out = document.createElement("canvas");
    out.width = src.width * scale * fit; out.height = src.height * scale * fit;
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

  // Finds a configured protocol code in the label text, ignoring OCR spacing and dashes.
  function protocolOnLabel(text) {
    const squeeze = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const label = squeeze(text);
    const found = allProtocols().filter((p) => label.includes(squeeze(p.code)))
      .sort((a, b) => b.code.length - a.code.length);
    return found.length ? found[0].id : null;
  }

  // The same reading for a photo just taken and for an uploaded image.
  async function readPhoto(file) {
    if (!file) return;
    if (S.reading) { setReadOut("Still reading the last photo."); return; }
    const mode = S.mode;
    S.reading = true;
    setReadOut("Reading photo…");
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
      const barcode = await readBarcode(image);
      let best = null;
      let labelProtocolId = null;
      const tries = [[0, 3, 0.8], [90, 3, 0.8], [180, 3, 0.8], [270, 3, 0.8],
                     [0, 3, 1], [90, 2, 1], [180, 2, 1], [270, 2, 1]];
      // Receiving needs serial, kit type and expiry. The other screens only need the serial.
      const complete = (p) => (p.serial || barcode) && (mode !== "receive" || (p.kit_type && p.expiry));
      for (let i = 0; i < tries.length; i++) {
        setReadOut(`Reading photo… (${i + 1} of ${tries.length})`);
        const [deg, scale, crop] = tries[i];
        const { data } = await worker.recognize(prepared(image, deg, scale, crop));
        best = mergeParsed(best, window.LabelReader.parseLabel(data.text));
        labelProtocolId = labelProtocolId || protocolOnLabel(data.text);
        if (complete(best)) break;
      }
      if (image.close) image.close();
      if (!best.serial) best.serial = barcode;
      if (S.mode === mode && S.tab === "scan") fillFromReading(best, mode, labelProtocolId);
    } catch (e) {
      setReadOut('<span class="err">Could not read that photo. Take a closer, sharper photo with the label upright.</span>');
    } finally {
      S.reading = false;
    }
  }

  function fillFromReading(p, mode, labelProtocolId) {
    const f = { receive: $("#receiveForm"), use: $("#useForm"), remove: $("#removeForm") }[mode];
    if (!f) return;
    if (p.serial) f.serial.value = p.serial;
    if (mode !== "receive") {
      setReadOut(p.serial
        ? '<span class="ok">Serial read. Check it against the kit.</span>'
        : '<span class="err">Serial not found. Take a closer photo or type it.</span>');
      syncUseForm();
      return;
    }
    if (p.kit_type) f.kit_type.value = p.kit_type;
    if (p.lot) f.lot.value = p.lot;
    if (p.expiry) f.expiry.value = p.expiry;
    f.product.value = p.kit_type ? `Kit Type ${p.kit_type}${p.protocol ? " · " + p.protocol : ""}` : "";
    S.labelProtocolId = labelProtocolId;
    S.allocTouched = false;
    syncReceiveForm();
    const issues = window.LabelReader.checkFields(p, (S.session && S.session.today) || todayISO());
    if (!p.serial) issues.unshift("serial");
    setReadOut(issues.length
      ? `<span class="err">Please check: ${issues.map(esc).join(", ")}.</span>`
      : '<span class="ok">Read the label. Check it against the kit, then save.</span>');
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
    showNewAlerts();
  }

  window.addEventListener("online", () => { S.online = true; boot(); });
  window.addEventListener("offline", () => { S.online = false; render(); });
  setInterval(() => { if (S.session && S.online) flush(); }, 15000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  boot();
})();
