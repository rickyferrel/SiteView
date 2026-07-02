import type { PGlite } from "@electric-sql/pglite";

// Seeds the Summit Creek development with the exact values reverse-engineered
// from the live WordPress embed + Mapbox style. Idempotent: safe to re-run.

const DEV_ID = "summit-creek";

const DEFAULT_VIEW = {
  center: [-111.663548, 40.008522],
  zoom: 15.42,
  pitch: 70,
  bearing: -173.81,
};

const STOP_VIEWS = {
  "home-base": { center: [-111.66702011816096, 40.0124611705875], zoom: 17.245370403546513, pitch: 70.48913278825343, bearing: 132.26468728313944 },
  "villa-lots": { center: [-111.66488752621004, 40.011110306617155], zoom: 16.588012761115362, pitch: 38, bearing: 16 },
  amenities: { center: [-111.66345860207852, 40.01077701965664], zoom: 17.644136026388427, pitch: 38, bearing: 16 },
  "loafer-circle": { center: [-111.66161699757755, 40.005119140343965], zoom: 16.447336539832214, pitch: 70.5, bearing: 160 },
  crest: { center: [-111.66480617706479, 40.00534527411969], zoom: 16.370671247042164, pitch: 70.5, bearing: 160 },
};

// Carried over from the style's match expression on SALES_STATUS.
const STATUSES = [
  { id: "sc-available", name: "Available", color: "#5e8c61", sort: 1, show: true, def: false },
  { id: "sc-under-contract", name: "Under Contract", color: "#c6a75e", sort: 2, show: true, def: false },
  { id: "sc-future-lot", name: "Future Lot", color: "#4f6d8a", sort: 3, show: true, def: false },
  { id: "sc-sold", name: "Sold", color: "#8c3b3b", sort: 4, show: false, def: true },
];

export async function seed(db: PGlite) {
  const existing = await db.query<{ count: number }>(
    "select count(*)::int as count from developments where id = $1",
    [DEV_ID]
  );
  if (existing.rows[0]?.count > 0) return;

  // Public `pk.` token from the environment (NEXT_PUBLIC_MAPBOX_TOKEN); see
  // .env.example. Empty if unset — the seeded embed then needs a token pasted
  // into the development before it renders.
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

  await db.query(
    `insert into developments (id, slug, name, mapbox_token, mapbox_style, default_view, stop_views, terrain_exaggeration)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      DEV_ID,
      DEV_ID,
      "Summit Creek",
      token,
      "mapbox://styles/tbelliston45/cmmv7xrgt002g01s6ef6l96o1",
      JSON.stringify(DEFAULT_VIEW),
      JSON.stringify(STOP_VIEWS),
      1.5,
    ]
  );

  for (const s of STATUSES) {
    await db.query(
      `insert into statuses (id, development_id, name, color, fill_opacity, sort_order, show_in_filter, is_default)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, DEV_ID, s.name, s.color, 0.75, s.sort, s.show, s.def]
    );
  }

  // A starter filter mirroring the site's "VIEW AVAILABLE" button.
  await db.query(
    `insert into filters (id, development_id, label, field_key, match_values, sort_order)
     values ($1,$2,$3,$4,$5,$6)`,
    ["sc-f-available", DEV_ID, "View Available", "status", JSON.stringify(["Available"]), 1]
  );

  // An example custom field to demonstrate the dynamic-field system.
  await db.query(
    `insert into field_defs (id, development_id, key, label, type, options, show_in_panel, filterable, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    ["sc-fd-view", DEV_ID, "view_type", "View", "select", JSON.stringify(["Mountain", "Valley", "Golf"]), true, true, 1]
  );
}

export const SEED_DEV_ID = DEV_ID;
