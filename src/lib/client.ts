// Tiny browser fetch helpers for the portal UI.

export async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

export async function jsend<T = unknown>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json().catch(() => ({})) as Promise<T>;
}
