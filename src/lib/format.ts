// Shared display formatters for operator-entered values. Values are stored as
// raw strings (e.g. "$425,000", "0.335278"), so these normalize them for the
// portal table, the lot editor, and the public embed alike.

// A USD price with no cents. Returns "" for empty/unparseable/zero input so
// callers can decide how to render a missing value.
export function money(v?: string | null): string {
  if (!v) return "";
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Acreage to 2 decimals; falls back to the raw string if it isn't numeric.
export function acres(v?: string | null): string {
  if (!v) return "";
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}
