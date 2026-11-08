/* Reads one still photo of a kit label on the device.
 * The barcode gives the serial. OCR finds which way up the label is, then the
 * small lines are cropped and enlarged from the full-size photo and read again.
 * Every read is a vote, so one bad read cannot decide a field. */
(function (root) {
  const WORK_SIDE = 2200;          // long side used to find the label
  const BARCODE_SIDE = 3000;       // long side given to the barcode reader
  const LINE_HEIGHT = 64;          // a cropped line is enlarged to about this height
  const SKEW_SIDE = 700;           // long side used to measure tilt
  const SKEW_MAX = 20;             // largest tilt corrected, in degrees
  const RIVAL_SHARE = 0.15;         // a value with this share of the winner's votes means the reads disagree
  const LINES_IN_BAND = 1.3;       // a band holds its line and a little either side

  function sizeOf(source) {
    return { w: source.videoWidth || source.naturalWidth || source.width,
             h: source.videoHeight || source.naturalHeight || source.height };
  }

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  function rotated(source, deg) {
    const { w, h } = sizeOf(source);
    const rad = (deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const c = canvasOf(w * cos + h * sin, w * sin + h * cos);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
    return c;
  }

  function scaled(source, factor) {
    const { w, h } = sizeOf(source);
    const c = canvasOf(w * factor, h * factor);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  function cropped(source, x, y, w, h) {
    const c = canvasOf(w, h);
    c.getContext("2d").drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // Grey, stretched between the darkest and lightest values, then sharpened.
  function enhanced(canvas, sharpen = true) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const grey = new Float32Array(w * h);
    const counts = new Uint32Array(256);
    for (let i = 0; i < grey.length; i++) {
      grey[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2];
      counts[Math.round(grey[i])]++;
    }
    // Ignore the extreme 1% so a dark background does not flatten the label.
    let lo = 0, hi = 255, seen = 0;
    const clip = grey.length * 0.01;
    while (lo < 255 && seen + counts[lo] < clip) seen += counts[lo++];
    seen = 0;
    while (hi > 0 && seen + counts[hi] < clip) seen += counts[hi--];
    const span = Math.max(1, hi - lo);
    const at = (x, y) => grey[y * w + x];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inner = sharpen && x > 0 && y > 0 && x < w - 1 && y < h - 1;
        const sharp = inner ? 2 * at(x, y) - (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4 : at(x, y);
        const v = Math.max(0, Math.min(255, ((sharp - lo) / span) * 255));
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // How far a photo is tilted, in degrees. Text and bars line up in rows or columns only
  // when the photo is straight, so this tries small turns and keeps the sharpest pattern.
  function estimateSkew(source) {
    const { w, h } = sizeOf(source);
    const small = scaled(source, Math.min(1, SKEW_SIDE / Math.max(w, h)));
    const W = small.width, H = small.height;
    const d = small.getContext("2d").getImageData(0, 0, W, H).data;
    const grey = new Float32Array(W * H);
    for (let i = 0; i < grey.length; i++) grey[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2];
    const points = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const edge = Math.abs(grey[y * W + x + 1] - grey[y * W + x - 1]) + Math.abs(grey[(y + 1) * W + x] - grey[(y - 1) * W + x]);
        if (edge > 90) points.push(x - W / 2, y - H / 2);
      }
    }
    if (points.length < 400) return 0;
    const size = W + H;
    const sharpness = (deg) => {
      const rad = (deg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const rows = new Float32Array(size * 2), cols = new Float32Array(size * 2);
      for (let i = 0; i < points.length; i += 2) {
        rows[Math.round(points[i] * sin + points[i + 1] * cos) + size]++;
        cols[Math.round(points[i] * cos - points[i + 1] * sin) + size]++;
      }
      let total = 0;
      for (let i = 0; i < rows.length; i++) total += rows[i] * rows[i] + cols[i] * cols[i];
      return total;
    };
    let best = 0, top = sharpness(0);
    for (let deg = -SKEW_MAX; deg <= SKEW_MAX; deg += 1) {
      const value = sharpness(deg);
      if (value > top) { top = value; best = deg; }
    }
    return best;
  }

  // ---------- barcode ----------
  let zxingLoad = null;
  function loadZxing() {
    if (!zxingLoad) {
      zxingLoad = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "/vendor/zxing/reader.js"; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      }).then(() => {
        root.ZXingWASM.prepareZXingModule({
          overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? `/vendor/zxing/${path}` : prefix + path) },
        });
      });
    }
    return zxingLoad;
  }

  const looksLikeSerial = (v) => /^[A-Z0-9]{8,14}$/i.test(String(v || "").trim());

  // Returns every serial-like code in the photo, with the angle the first one sits at.
  async function readBarcodes(source) {
    const found = [];
    let angle = null;
    try {
      await loadZxing();
      const { w, h } = sizeOf(source);
      const factor = Math.min(1, BARCODE_SIDE / Math.max(w, h));
      const canvas = scaled(source, factor);
      const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const results = await root.ZXingWASM.readBarcodes(image, { tryHarder: true, tryRotate: true, tryDownscale: true, maxNumberOfSymbols: 4 });
      results.filter((r) => r.isValid && looksLikeSerial(r.text)).forEach((r) => {
        if (angle === null) angle = r.orientation;
        found.push(r.text.trim());
      });
    } catch (e) { /* the browser's own detector may still work below */ }
    if (!found.length && "BarcodeDetector" in root) {
      try {
        const detected = await new root.BarcodeDetector().detect(source);
        detected.map((f) => String(f.rawValue || "").trim()).filter(looksLikeSerial).forEach((v) => found.push(v));
      } catch (e) { /* no barcode from this photo; OCR reads the printed serial */ }
    }
    return { values: [...new Set(found)], angle };
  }

  // Which ways up to try. The barcode runs along the text, so its exact angle also straightens a tilted photo.
  function rotationOrder(angle) {
    if (angle === null || angle === undefined) return [90, 270, 0, 180];
    const first = ((-angle % 360) + 360) % 360;
    return [first, (first + 180) % 360, (first + 90) % 360, (first + 270) % 360];
  }

  const squeezed = (v) => String(v).toUpperCase().replace(/O/g, "0");
  const closeTo = (a, b) => root.LabelReader.editDistance(squeezed(a), squeezed(b)) <= 3;

  // A label can carry a barcode that is not the serial, so the printed number has a say.
  function chooseSerial(barcodes, printed, printedVotes) {
    const match = barcodes.find((b) => closeTo(b, printed));
    if (match) return { serial: match, conflict: null };
    if (!printed) return { serial: barcodes[0] || "", conflict: null };
    if (!barcodes.length) return { serial: printed, conflict: null };
    const conflict = { barcode: barcodes[0], printed };
    return { serial: printedVotes >= 2 ? printed : barcodes[0], conflict };
  }

  // ---------- OCR ----------
  function linesOf(data) {
    const out = [];
    (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => out.push(l))));
    return out;
  }

  async function ocr(worker, canvas, mode) {
    await worker.setParameters({ tessedit_pageseg_mode: mode, user_defined_dpi: "300" });
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    return data;
  }

  function newVotes() {
    const table = { serial: {}, kit_type: {}, lot: {}, expiry: {}, expiry_seen: {}, protocol: {} };
    return {
      add(parsed, weight) {
        Object.keys(table).forEach((field) => {
          const value = parsed[field];
          if (value) table[field][value] = (table[field][value] || 0) + weight;
        });
      },
      best(field) {
        const entries = Object.entries(table[field]).sort((a, b) => b[1] - a[1]);
        return entries.length ? entries[0][0] : "";
      },
      score(field) {
        const entries = Object.entries(table[field]).sort((a, b) => b[1] - a[1]);
        return entries.length ? entries[0][1] : 0;
      },
      all(field) { return Object.keys(table[field]); },
      // The other values read, when they carry real weight against the best one.
      rivals(field) {
        const entries = Object.entries(table[field]).sort((a, b) => b[1] - a[1]);
        return entries.slice(1).filter((e) => e[1] >= entries[0][1] * RIVAL_SHARE).map((e) => e[0]);
      },
    };
  }

  // Finds the bands of the small lines from the lines around them.
  function bandsToReread(lines, toMaster, master) {
    const find = (re) => lines.find((l) => re.test(l.text));
    const kit = find(/\bK\w{0,3}\s*Type\b/i);
    const protocol = find(/Protocol/i);
    const lot = find(/\bLot\b|Expiry|Expir/i);
    const visit = find(/Visit/i);
    const anchor = kit || protocol || lot || visit;
    if (!anchor) return [];
    const widest = Math.max(...lines.filter((l) => l.confidence > 30).map((l) => l.bbox.x1 - anchor.bbox.x0), 1);
    const band = (y0, y1, pad) => {
      const x = Math.max(0, (anchor.bbox.x0 - 8)) * toMaster;
      const y = Math.max(0, y0 - pad) * toMaster;
      const w = Math.min(master.width - x, Math.max(widest * 1.1, 400) * toMaster);
      const h = Math.min(master.height - y, (y1 - y0 + pad * 2) * toMaster);
      return { x, y, w, h };
    };
    const out = [];
    // Lot and expiry sit between the protocol line and the visit line.
    if (protocol && visit && visit.bbox.y0 > protocol.bbox.y1) {
      out.push(band(protocol.bbox.y1, visit.bbox.y0, 2));
    } else if (lot) {
      const height = lot.bbox.y1 - lot.bbox.y0;
      out.push(band(lot.bbox.y0, lot.bbox.y1, height * 0.3));
    }
    // The kit type sits on the line above the protocol.
    if (kit) {
      const height = kit.bbox.y1 - kit.bbox.y0;
      out.push(band(kit.bbox.y0, kit.bbox.y1, height * 0.3));
    } else if (protocol) {
      const height = protocol.bbox.y1 - protocol.bbox.y0;
      out.push(band(protocol.bbox.y0 - height * 2.2, protocol.bbox.y0, 0));
    }
    return out;
  }

  const anchorScore = (text) => [/\bK\w{0,3}\s*Type\b/i, /Protocol/i, /Lot\s*\/?\s*Expiry|Expiration/i, /Visit/i, /Syneos|ppd/i]
    .filter((re) => re.test(text)).length;

  // Finds which way up the label is, then re-reads its small lines. Every read goes into votes.
  async function readView(source, skew, degrees, worker, votes, texts, progress) {
    const parse = root.LabelReader.parseLabel;
    const straight = skew ? rotated(source, skew) : source;
    const { w, h } = sizeOf(straight);
    const factor = Math.min(3, WORK_SIDE / Math.max(w, h));
    let found = null;
    for (let i = 0; i < degrees.length; i++) {
      progress(`Finding the label… (${i + 1} of ${degrees.length})`);
      const view = enhanced(rotated(scaled(straight, factor), degrees[i]));
      const data = await ocr(worker, view, "3");
      texts.push(data.text);
      const score = anchorScore(data.text);
      votes.add(parse(data.text), score >= 2 ? 2 : 1);
      if (!found || score > found.score) found = { score, deg: degrees[i], data };
      if (score >= 3) break;
    }
    if (found && found.score >= 1) {
      const master = rotated(straight, found.deg);
      const bands = bandsToReread(linesOf(found.data), 1 / factor, master);
      for (let b = 0; b < bands.length; b++) {
        const box = bands[b];
        // Different sizes make different mistakes, so the agreeing value is usually right.
        const sizes = [[LINE_HEIGHT, false], [LINE_HEIGHT * 1.4, true], [LINE_HEIGHT * 0.7, false]];
        for (let i = 0; i < sizes.length; i++) {
          progress(`Reading the small print… (${b + 1}.${i + 1})`);
          const crop = cropped(master, box.x, box.y, box.w, box.h);
          const view = enhanced(scaled(crop, Math.max(1, (sizes[i][0] * LINES_IN_BAND) / box.h)), sizes[i][1]);
          const data = await ocr(worker, view, "6");
          texts.push(data.text);
          votes.add(parse(data.text), 3);
        }
      }
    }
    return found;
  }

  async function read(source, worker, options) {
    const parse = root.LabelReader.parseLabel;
    const progress = options.onProgress || (() => {});
    const onlySerial = options.need === "serial";
    const votes = newVotes();
    const texts = [];

    progress("Looking for the barcode…");
    const barcodes = await readBarcodes(source);
    // Screens that only need the serial can stop at a barcode for a kit already in stock.
    const known = barcodes.values.find((v) => options.isKnown && options.isKnown(v));
    if (onlySerial && known) return { serial: known, conflict: null, kit_type: "", lot: "", expiry: "", protocol: "", visits: [], text: "", disputed: {} };

    progress("Straightening the photo…");
    const skew = estimateSkew(source);
    const degrees = rotationOrder(barcodes.angle);
    let found = await readView(source, skew, degrees, worker, votes, texts, progress);
    // Straightening can make a nearly straight photo worse, so try once without it.
    if (skew && !onlySerial && !(votes.best("kit_type") && votes.best("expiry"))) {
      found = (await readView(source, 0, degrees, worker, votes, texts, progress)) || found;
    }

    const { serial, conflict } = chooseSerial(barcodes.values, votes.best("serial"), votes.score("serial"));
    const visits = found ? parse(found.data.text).visits : [];
    const expiry = votes.best("expiry");
    return { serial, conflict, kit_type: votes.best("kit_type"), lot: votes.best("lot"), expiry,
             protocol: votes.best("protocol"), visits, text: texts.join("\n"),
             // Any other date read is enough to ask for a check, even one with an impossible year.
             disputed: { kit_type: votes.rivals("kit_type"), lot: votes.rivals("lot"),
                         expiry: votes.all("expiry_seen").filter((v) => v !== expiry) } };
  }

  root.KitReader = { read, readBarcodes, chooseSerial, rotationOrder, estimateSkew };
})(typeof window !== "undefined" ? window : globalThis);
