/* Reads the printed text on a kit box label.
 * Works in the browser and in Node (for tests). It extracts printed fields
 * independently so a value is never put in the wrong column. */
(function (root) {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                   jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // "31-Jan-2027" (OCR may drop or add spaces or dashes) -> "2027-01-31"
  function parseExpiry(text) {
    const candidates = [
      ...text.matchAll(/(\d{1,2})\s*[-\s./]?\s*([A-Za-z]{3})\s*[-\s./]?\s*(\d{4})/g),
      ...text.matchAll(/(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})/g),
    ];
    for (const m of candidates) {
      const month = m[2].match(/^\d+$/) ? +m[2] : MONTHS[m[2].toLowerCase()];
      const d = +m[1];
      const y = +(m[3] || m[4]);
      if (!month || d < 1 || d > 31 || y < 2020 || y > 2100) continue;
      const daysInMonth = new Date(Date.UTC(y, month, 0)).getUTCDate();
      if (d <= daysInMonth) {
        return `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    return null;
  }

  function parseLabel(raw) {
    const text = String(raw || "").replace(/[|]/g, "I");
    const compact = text.replace(/\s+/g, " ").trim();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = { serial: "", kit_type: "", protocol: "", lot: "", expiry: "", visits: [], problems: [] };

    const serials = compact.match(/\b\d{8,14}\b/g) || [];
    if (serials.length) out.serial = serials[serials.length - 1];

    const kit = /\bKit\s*Type\s*([A-J])\b/i.exec(compact) ||
      /\bK\w{0,3}\s*Type\s*([A-J])\b/i.exec(compact) ||
      /\bType\s*([A-J])\b/i.exec(compact);
    if (kit) out.kit_type = kit[1].toUpperCase();
    else out.problems.push("Kit type not found");

    const proto = /TAK\s*[-–—]?\s*\d{3}\s*[-–—]\s*\d{4}/i.exec(compact);
    if (proto) out.protocol = proto[0];

    // Lot numbers look like TKDA0215-TPCUS535228 or TKDA0215-248128
    const lot = /TKDA\s*[0-9OQ]{3,4}\s*[-–—]\s*[A-Z0-9]{5,}/i.exec(compact);
    if (lot) out.lot = lot[0].toUpperCase().replace(/\s+/g, "").replace(/(?<=\d)O|O(?=\d)/g, "0");
    else out.problems.push("Lot not found");

    const exp = parseExpiry(compact);
    if (exp) out.expiry = exp;
    else out.problems.push("Expiry date not found");

    // Visits: the text after "Visit(s)" on the same line or the next line
    const vi = lines.findIndex((l) => /Visit\(?s?\)?/i.test(l));
    if (vi >= 0) {
      let v = lines[vi].replace(/.*Visit\(?s?\)?\s*:?/i, "").trim();
      if (!v && lines[vi + 1]) v = lines[vi + 1];
      out.visits = v.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
    }
    if (!out.visits.length) {
      const visit = /Day\s*[-–—]?\s*\d+(?:\s*,\s*(?:Early\s*Term|At\s*Discharge))?/i.exec(compact);
      if (visit) out.visits = [visit[0].replace(/\s+/g, " ").trim()];
    }
    if (!out.visits.length) out.problems.push("Visit not found");

    return out;
  }

  // Checks the parsed fields against the rules so the reader can show what to fix.
  function checkFields(f, today) {
    const issues = [];
    if (!f.kit_type) issues.push("kit type");
    if (!f.lot) issues.push("lot");
    if (!f.expiry) issues.push("expiry");
    if (f.expiry && today && f.expiry < today) issues.push("expiry is in the past");
    return issues;
  }

  const api = { parseExpiry, parseLabel, checkFields };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LabelReader = api;
})(typeof window !== "undefined" ? window : globalThis);
