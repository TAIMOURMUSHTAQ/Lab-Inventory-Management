/* Works out the expiry and low stock alerts from the kits on this device.
 * Works in the browser and in Node (for tests). Runs on the device so alerts
 * include actions still waiting to send and also work offline. */
(function (root) {
  const DAY_MS = 86400000;

  function daysUntil(expiry, today) {
    return Math.round((Date.parse(expiry) - Date.parse(today)) / DAY_MS);
  }

  // Expired kits stay in stock until someone removes them, but cannot be used.
  function isUsable(box, today) {
    return box.status === "in_stock" && !(box.expiry && box.expiry < today);
  }

  function lowStockLimit(config, kitType, protocolId) {
    const override = (config.overrides || []).find((o) =>
      o.kit_type === kitType && o.protocol_id === (protocolId || 0));
    if (override) return override.threshold;
    return protocolId ? config.settings.low_stock_protocol : config.settings.low_stock_total;
  }

  function expiryAlerts(boxes, config, today, codeOf) {
    return boxes
      .filter((b) => b.status === "in_stock" && b.expiry &&
        daysUntil(b.expiry, today) <= config.settings.expiry_days)
      .sort((a, b) => a.expiry.localeCompare(b.expiry))
      .map((b) => {
        const days = daysUntil(b.expiry, today);
        const when = days < 0 ? `expired on ${b.expiry}`
          : days === 0 ? "expires today"
          : `expires ${b.expiry} (in ${days} day${days === 1 ? "" : "s"})`;
        return { key: `expiry:${b.serial}`, kind: days < 0 ? "expired" : "expiring", serial: b.serial,
                 text: `Kit ${b.kit_type}, serial ${b.serial} ${when}. ${codeOf(b.protocol_id)}.` };
      });
  }

  // Only scopes that have held stock are checked, so a protocol that has never
  // been given a kit type does not alert. Running out afterwards still alerts.
  function lowStockAlerts(boxes, config, today, codeOf) {
    const out = [];
    const usable = boxes.filter((b) => isUsable(b, today));
    const types = [...new Set(boxes.map((b) => b.kit_type))].sort();
    types.forEach((kit) => {
      const ofType = usable.filter((b) => b.kit_type === kit);
      const limit = lowStockLimit(config, kit, 0);
      if (ofType.length <= limit) {
        out.push({ key: `low:all:${kit}:${ofType.length}`, kind: "low", count: ofType.length,
                   text: `Kit ${kit}: ${ofType.length} left in total (alert at ${limit}).` });
      }
      const protocolIds = [...new Set(boxes.filter((b) => b.kit_type === kit && b.protocol_id)
        .map((b) => b.protocol_id))];
      const spare = ofType.filter((b) => !b.protocol_id).length;
      protocolIds.forEach((id) => {
        const count = ofType.filter((b) => b.protocol_id === id).length;
        const protocolLimit = lowStockLimit(config, kit, id);
        if (count <= protocolLimit) {
          const note = spare ? ` ${spare} unallocated available.` : "";
          out.push({ key: `low:${id}:${kit}:${count}`, kind: "low", count,
                     text: `Kit ${kit} for ${codeOf(id)}: ${count} left (alert at ${protocolLimit}).${note}` });
        }
      });
    });
    return out.sort((a, b) => a.count - b.count);
  }

  function computeAlerts(boxes, config, today) {
    if (!config || !config.settings || config.settings.expiry_days === undefined) return [];
    const codes = {};
    (config.studies || []).forEach((s) => s.protocols.forEach((p) => { codes[p.id] = p.code; }));
    const codeOf = (id) => codes[id] || "Unallocated";
    return [...expiryAlerts(boxes, config, today, codeOf), ...lowStockAlerts(boxes, config, today, codeOf)];
  }

  const api = { computeAlerts, isUsable, daysUntil, lowStockLimit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.KitAlerts = api;
})(typeof window !== "undefined" ? window : globalThis);
