// Postgres DDL. Runs on both PGlite (local dev) and Supabase/Postgres (prod).
// Geometry is stored as GeoJSON in jsonb (no PostGIS needed — the spatial query
// happens server-side at ArcGIS; we only store + serve the polygons).

export const SCHEMA_SQL = `
create table if not exists developments (
  id                   text primary key,
  slug                 text unique not null,
  name                 text not null,
  mapbox_token         text not null,
  mapbox_style         text not null,
  default_view         jsonb not null,
  stop_views           jsonb not null default '{}'::jsonb,
  terrain_exaggeration real not null default 1.5,
  created_at           timestamptz not null default now()
);

-- Map appearance (basemap + terrain) the operator picks per development.
-- Added via ALTER so existing data dirs migrate on next boot.
alter table developments
  add column if not exists map_appearance jsonb not null
  default '{"basemap":"custom","terrain":true,"terrainExaggeration":1.5}'::jsonb;

-- Whether the operator has explicitly framed the opening view. When true the
-- embed opens exactly at default_view; when false it auto-fits the lot cluster.
alter table developments
  add column if not exists view_locked boolean not null default false;

-- Customer preview link: the /preview/{slug}?k={token} page only answers to
-- this token, and only until it expires (7 days from mint or reset).
-- Null = never minted.
alter table developments
  add column if not exists preview_token text;
alter table developments
  add column if not exists preview_expires_at timestamptz;

create table if not exists statuses (
  id             text primary key,
  development_id text not null references developments(id) on delete cascade,
  name           text not null,
  color          text not null,
  fill_opacity   real not null default 0.75,
  sort_order     int not null default 0,
  show_in_filter boolean not null default true,
  is_default     boolean not null default false
);
create index if not exists statuses_dev on statuses(development_id);

create table if not exists field_defs (
  id             text primary key,
  development_id text not null references developments(id) on delete cascade,
  key            text not null,
  label          text not null,
  type           text not null,
  options        jsonb,
  show_in_panel  boolean not null default true,
  filterable     boolean not null default false,
  sort_order     int not null default 0,
  unique(development_id, key)
);
create index if not exists field_defs_dev on field_defs(development_id);

create table if not exists filters (
  id             text primary key,
  development_id text not null references developments(id) on delete cascade,
  label          text not null,
  field_key      text not null,
  match_values   jsonb not null default '[]'::jsonb,
  sort_order     int not null default 0
);
create index if not exists filters_dev on filters(development_id);

create table if not exists parcels (
  id               text primary key,
  development_id   text not null references developments(id) on delete cascade,
  parcel_id        text not null,
  geometry         jsonb not null,
  status_id        text references statuses(id) on delete set null,
  lot_number       text,
  property_address text,
  list_price       text,
  parcel_acres     text,
  image_url        text,
  video_url        text,
  lot_page_url     text,
  owner_name       text,
  properties       jsonb not null default '{}'::jsonb,
  source_attrs     jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  unique(development_id, parcel_id)
);
create index if not exists parcels_dev on parcels(development_id);

create table if not exists publications (
  id             text primary key,
  development_id text not null references developments(id) on delete cascade,
  snapshot       jsonb not null,
  note           text,
  published_at   timestamptz not null default now()
);
create index if not exists publications_dev on publications(development_id, published_at desc);

-- Overlay image bytes, deliberately in their own table and NOT on the layer row.
-- publish() snapshots the whole draft config into publications.snapshot, so bytes
-- riding on a layer would be duplicated into every publication. Layers carry an
-- opaque asset_id instead; bytes are served from /api/asset/{id} and cached hard
-- (immutable — a re-upload mints a new id). Assets are referenced by past
-- publications, so deleting a layer must never delete its asset: orphans are
-- left in place on purpose. Moving to S3 later touches this table and that route
-- only — everything upstream sees an opaque id.
create table if not exists layer_assets (
  id         text primary key,
  mime       text not null,
  bytes      bytea not null,
  width      int not null,
  height     int not null,
  byte_size  int not null,
  created_at timestamptz not null default now()
);

-- Non-parcel map features: a pinned site-plan render ('image') or a drawn
-- polygon/line ('shape'). Rides the draft/published machinery via MapConfig.
create table if not exists layers (
  id             text primary key,
  development_id text not null references developments(id) on delete cascade,
  kind           text not null,
  name           text not null,
  sort_order     int not null default 0,
  visible        boolean not null default true,
  opacity        real not null default 1.0,
  above_lots     boolean not null default false,
  visitor_toggle boolean not null default false,
  asset_id       text references layer_assets(id) on delete set null,
  corners        jsonb,
  geometry       jsonb,
  style          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists layers_dev on layers(development_id, sort_order);
`;
