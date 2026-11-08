/* Reads the printed text on a kit box label.
 * Works in the browser and in Node (for tests). It extracts printed fields
 * independently so a value is never put in the wrong column. */
(function (root) {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                   jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  const NAMES = Object.keys(MONTHS);
  const editDistance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const keep = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = keep;
      }
    }
    return row[b.length];
  };

  // "Dee" or "0ct" -> the month, but only when one month is clearly closest.
  function monthNumber(raw) {
    const word = raw.toLowerCase().replace(/0/g, "o");
    if (MONTHS[word]) return MONTHS[word];
    const close = NAMES.filter((n) => editDistance(word, n) === 1);
    return close.length === 1 ? MONTHS[close[0]] : 0;
  }

  // Letters OCR often reads in place of digits.
  const digits = (v) => v.replace(/[OoQ]/g, "0").replace(/[IlL|]/g, "1").replace(/[Ss]/g, "5").replace(/[Zz]/g, "2").replace(/B/g, "8");

  // "31-Jan-2027" (OCR may drop or add spaces or dashes) -> "2027-01-31"
  // anyYear also returns dates with an impossible year, which show the year was hard to read.
  function parseExpiry(text, anyYear) {
    const D = "[0-9OoQIlLSsZzB|]";
    const candidates = [
      ...text.matchAll(new RegExp(`(?<![0-9A-Za-z])(${D}{1,2})\\s*[-\\s./]?\\s*([A-Za-z0-9]{3})\\s*[-\\s./]?\\s*(${D}{4})(?![0-9])`, "g")),
      ...text.matchAll(/(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})/g),
      // the date straight after a lot number, with the separator lost
      ...text.matchAll(/\d(\d{2})\s*[-\s./]\s*([A-Za-z]{3})\s*[-\s./]?\s*(\d{4})/g),
    ];
    for (const m of candidates) {
      const month = /^\d+$/.test(m[2]) ? +m[2] : /^[A-Za-z0-9]{3}$/.test(m[2]) && /[A-Za-z]{2}/.test(m[2]) ? monthNumber(m[2]) : 0;
      const d = +digits(m[1]);
      const y = +digits(m[3]);
      // A misread year is usually far away, and kits are not stocked for that long.
      const thisYear = new Date().getFullYear();
      if (!month || month > 12 || d < 1 || d > 31) continue;
      if (!anyYear && (y < thisYear - 2 || y > thisYear + 8)) continue;
      const daysInMonth = new Date(Date.UTC(y, month, 0)).getUTCDate();
      if (d <= daysInMonth) {
        return `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    return null;
  }

  // Serials are 8 to 14 characters. PPD serials are 39, a letter O, then 8 digits.
  function normaliseSerial(raw) {
    const plain = raw.toUpperCase().replace(/[OQ]/g, "0");
    return /^390\d{8}$/.test(plain) ? `39O${plain.slice(3)}` : plain;
  }

  function parseSerial(compact) {
    const found = (compact.match(/(?<![A-Za-z0-9-])[0-9][0-9OoQ]{7,13}(?![A-Za-z0-9-])/g) || [])
      .map(normaliseSerial)
      .filter((v) => !/^(19|20)\d{6}$/.test(v));
    return found.length ? found[found.length - 1] : "";
  }

  // Labels with no "Kit Type" line print a short kit name next to the visit name.
  const VISIT_WORDS = /\b(PRE[-\s]?SCREENING|SCREENING|BASELINE|FOLLOW[-\s]?UP)\b/;
  function kitNearVisit(lines) {
    const i = lines.findIndex((l) => VISIT_WORDS.test(l));
    if (i < 0) return "";
    for (const n of [i - 1, i + 1, i + 2, i - 2]) {
      const first = lines[n] ? lines[n].split(/\s+/)[0].replace(/[^A-Za-z]/g, "") : "";
      if (first === lines[n]?.split(/\s+/)[0] && /^[A-Z]{2,8}$/.test(first) && !VISIT_WORDS.test(first)) return first;
    }
    return "";
  }

  function parseLabel(raw) {
    const text = String(raw || "").replace(/[|]/g, "I");
    const compact = text.replace(/\s+/g, " ").trim();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = { serial: "", kit_type: "", protocol: "", lot: "", expiry: "", visits: [], problems: [] };

    out.serial = parseSerial(compact);

    const kit = /\bKit\s*Type\s*([A-Z1])(?![A-Za-z0-9])/i.exec(compact) ||
      /\bK\w{0,3}\s*Type\s*([A-Z1])(?![A-Za-z0-9])/i.exec(compact) ||
      /\bT?ype\s*([A-Z1])(?![A-Za-z0-9])/i.exec(compact);
    // OCR often reads a capital I as a lowercase l or a 1.
    if (kit) out.kit_type = kit[1] === "l" || kit[1] === "1" ? "I" : kit[1].toUpperCase();
    else out.kit_type = kitNearVisit(lines);
    if (!out.kit_type) out.problems.push("Kit type not found");

    const proto = /TAK\s*[-–—]?\s*\d{3}\s*[-–—]\s*\d{4}/i.exec(compact);
    if (proto) out.protocol = proto[0];

    // Lot numbers look like TKDA0215-TPCUS535228 or TKDA0215-248128
    const lot = /T[KX]DA\s*[0-9OQ]{3,4}\s*[-–—]\s*([A-Z0-9]{5,})/i.exec(compact);
    if (lot) {
      // Anything after the letters of the lot is a digit.
      const tail = lot[1].toUpperCase().replace(/^(TPCU[S5])?(.*)$/, (_, head, rest) => (head ? "TPCUS" : "") + digits(rest));
      const head = lot[0].slice(0, lot[0].length - lot[1].length).toUpperCase().replace(/[\s–—]/g, "").replace(/^TX/, "TK").replace(/[OQ]/g, "0");
      out.lot = (head.endsWith("-") ? head : `${head}-`) + tail;
    } else out.problems.push("Lot not found");

    out.expiry_seen = parseExpiry(compact, true) || "";
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
    if (!f.expiry) issues.push("expiry");
    if (f.expiry && today && f.expiry < today) issues.push("expiry is in the past");
    return issues;
  }

  const api = { parseExpiry, parseLabel, checkFields, editDistance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LabelReader = api;
})(typeof window !== "undefined" ? window : globalThis);
