// Build a `pg` client config from the environment, tolerating passwords that
// contain URL-reserved characters (@ : / ? # % …) which would break a raw
// connection string. We split the URL manually and pass the password as a
// literal field instead of relying on WHATWG URL parsing.
//
// Precedence: DATABASE_URL (parsed leniently) → discrete PGHOST/PGPASSWORD/etc.
export function pgConfigFromEnv() {
  const ssl = { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED === "1" };
  const max = Number(process.env.PGPOOL_MAX ?? 2);

  const url = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
  if (!url) {
    // No URL: let pg read standard libpq env vars (PGHOST, PGPASSWORD, …).
    return { ssl, max };
  }

  // postgres[ql]://user:password@host[:port]/database[?query]
  // user stops at the first ':'; password is greedy up to the LAST '@' so it may
  // itself contain ':' '@' '/' '?' '#' etc.
  const m = url.match(
    /^postgres(?:ql)?:\/\/([^:@]+):(.*)@([^:/?]+)(?::(\d+))?\/([^?]+)/i
  );
  if (!m) {
    throw new Error(
      "DATABASE_URL is not in postgres://user:password@host:port/database form"
    );
  }
  const [, user, password, host, port, database] = m;
  return {
    user,
    password,
    host,
    port: port ? Number(port) : 5432,
    database,
    ssl,
    max,
  };
}
