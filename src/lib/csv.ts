// CSV lot enrichment: parse an operator's spreadsheet export in the browser,
// match its rows to existing lots, and guess column → field mappings. Pure
// module — no server-only imports — so the wizard's preview computes exactly
// what the import API applies.

import type { FieldType } from "./types";

// ---- Parsing ------------------------------------------------------------------

export type ParsedCsv = {
  headers: string[];
  /** Data rows, each padded/trimmed to headers.length, cells trimmed. */
  rows: string[][];
  delimiter: string;
};

// Excel in some locales exports semicolon-delimited "CSV"; sniff the header
// line (outside quotes) instead of assuming commas.
function sniffDelimiter(text: string): string {
  const nl = text.indexOf("\n");
  const line = nl === -1 ? text : text.slice(0, nl);
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let count = 0;
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === d) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC-4180-ish parse: quoted cells, "" escapes, newlines inside quotes. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2) {
    throw new Error("The file needs a header row plus at least one data row.");
  }

  // Name blank headers and disambiguate duplicates so column mapping is stable.
  const seen = new Map<string, number>();
  const headers = nonEmpty[0].map((h, i) => {
    let name = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
  const data = nonEmpty.slice(1).map((r) => headers.map((_, i) => (r[i] ?? "").trim()));
  return { headers, rows: data, delimiter };
}

// ---- Matching CSV rows to lots --------------------------------------------------

export type LotRef = {
  rowId: string;
  parcel_id: string;
  lot_number: string | null;
  property_address: string | null;
};

/** Lowercase alphanumerics only — "LOT-001" and "lot 001" compare equal. */
export function normKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** normKey with leading zeros stripped inside digit runs — "LOT-001" ≈ "Lot 1". */
export function looseKey(v: string): string {
  return normKey(v).replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ""));
}

/** looseKey with a leading alpha run dropped — "LOT-001" → "1", so a bare
 *  number in the CSV still finds its lot. Only ever applied to lot numbers. */
function numKey(v: string): string {
  return looseKey(v).replace(/^[a-z]+/, "");
}

export type LotIndex = {
  exact: Map<string, LotRef[]>;
  loose: Map<string, LotRef[]>;
  num: Map<string, LotRef[]>;
};

export function buildLotIndex(lots: LotRef[]): LotIndex {
  const exact = new Map<string, LotRef[]>();
  const loose = new Map<string, LotRef[]>();
  const num = new Map<string, LotRef[]>();
  const add = (m: Map<string, LotRef[]>, k: string, lot: LotRef) => {
    if (!k) return;
    const a = m.get(k);
    if (a) {
      if (!a.includes(lot)) a.push(lot);
    } else m.set(k, [lot]);
  };
  for (const lot of lots) {
    for (const v of [lot.lot_number, lot.parcel_id, lot.property_address]) {
      if (!v) continue;
      add(exact, normKey(v), lot);
      add(loose, looseKey(v), lot);
    }
    if (lot.lot_number) add(num, numKey(lot.lot_number), lot);
  }
  return { exact, loose, num };
}

export type MatchResult = {
  lot: LotRef | null;
  /** Populated when the value hits more than one lot — needs a manual pick. */
  ambiguous: LotRef[];
};

/** Match one CSV cell against lot number / parcel ID / address, exact then loose. */
export function matchLot(index: LotIndex, value: string): MatchResult {
  const v = value.trim();
  if (!v) return { lot: null, ambiguous: [] };
  const tries: Array<[Map<string, LotRef[]>, string]> = [
    [index.exact, normKey(v)],
    [index.loose, looseKey(v)],
    [index.num, numKey(v)],
  ];
  for (const [m, k] of tries) {
    const hits = m.get(k);
    if (hits && hits.length === 1) return { lot: hits[0], ambiguous: [] };
    if (hits && hits.length > 1) return { lot: null, ambiguous: hits };
  }
  return { lot: null, ambiguous: [] };
}

/** The column whose values match the most distinct lots — the identifier guess. */
export function bestMatchColumn(headers: string[], rows: string[][], index: LotIndex): number {
  let best = 0;
  let bestScore = -1;
  for (let c = 0; c < headers.length; c++) {
    const matched = new Set<string>();
    for (const r of rows) {
      const m = matchLot(index, r[c] ?? "");
      if (m.lot) matched.add(m.lot.rowId);
    }
    if (matched.size > bestScore) {
      best = c;
      bestScore = matched.size;
    }
  }
  return best;
}

// ---- Column → field guesses ------------------------------------------------------

export type CoreKey =
  | "lot_number"
  | "property_address"
  | "list_price"
  | "parcel_acres"
  | "image_url"
  | "video_url"
  | "lot_page_url";

export const CORE_TARGETS: Array<{ key: CoreKey; label: string }> = [
  { key: "lot_number", label: "Lot number" },
  { key: "property_address", label: "Address" },
  { key: "list_price", label: "List price" },
  { key: "parcel_acres", label: "Acres" },
  { key: "image_url", label: "Image URL" },
  { key: "video_url", label: "Video URL" },
  { key: "lot_page_url", label: "Lot page URL" },
];

// Header spellings (normKey'd) that map straight onto a core field or status.
const HEADER_GUESSES: Array<[CoreKey | "status", string[]]> = [
  ["lot_number", ["lotnumber", "lotno", "lotnum", "lot", "lotname", "lotlabel"]],
  ["property_address", ["propertyaddress", "address", "situsaddress", "situs", "fulladdress", "streetaddress"]],
  ["list_price", ["listprice", "price", "askingprice", "listedprice", "saleprice"]],
  ["parcel_acres", ["parcelacres", "acres", "acreage", "lotacres", "gisacres", "areaacres", "lotsize"]],
  ["image_url", ["imageurl", "image", "photo", "photourl", "picture", "imagelink"]],
  ["video_url", ["videourl", "video", "videolink", "tour", "toururl"]],
  ["lot_page_url", ["lotpageurl", "lotpage", "pageurl", "listingurl", "weburl", "website", "link", "url"]],
  ["status", ["status", "salesstatus", "salestatus", "availability", "lotstatus"]],
];

export function guessCoreTarget(header: string): CoreKey | "status" | null {
  const h = normKey(header);
  for (const [key, names] of HEADER_GUESSES) if (names.includes(h)) return key;
  return null;
}

/** Infer a sensible field type (and select options) from a column's values. */
export function guessFieldType(values: string[]): { type: FieldType; options: string[] | null } {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (vals.length === 0) return { type: "text", options: null };
  if (vals.every((v) => /^(yes|no|true|false|y|n)$/i.test(v))) return { type: "bool", options: null };
  if (vals.every((v) => /^https?:\/\//i.test(v))) return { type: "url", options: null };
  if (vals.every((v) => /\d/.test(v) && /^\$?\s?[\d,]+(\.\d+)?$/.test(v))) {
    return { type: vals.some((v) => v.includes("$")) ? "money" : "number", options: null };
  }
  const distinct = [...new Set(vals)];
  if (
    distinct.length >= 2 &&
    distinct.length <= 8 &&
    distinct.length <= Math.max(2, Math.ceil(vals.length / 2)) &&
    distinct.every((d) => d.length <= 32)
  ) {
    return { type: "select", options: distinct };
  }
  return { type: "text", options: null };
}

export function parseCsvBool(v: string): boolean {
  return /^(yes|y|true|1)$/i.test(v.trim());
}

/** A safe, unique field key derived from a human label. */
export function fieldKeyFromLabel(label: string, taken: Set<string>): string {
  let base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  if (/^\d/.test(base)) base = `f_${base}`;
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

// Keys the flattened embed/lot-row properties already use — a custom field with
// one of these keys would shadow core data in every panel, so never mint one.
export const RESERVED_FIELD_KEYS = new Set<string>([
  "rowId",
  "parcel_id",
  "status",
  "status_color",
  "status_default",
  "owner_name",
  ...CORE_TARGETS.map((t) => t.key),
]);
