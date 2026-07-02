-- Map Portal schema — mirrors src/lib/schema.ts (SCHEMA_SQL).
-- Idempotent: safe to run repeatedly. Apply to RDS via CloudShell + psql
-- (see AWS_SETUP_RUNBOOK.md Phase 4) or `npm run migrate` with DATABASE_URL set.
-- Geometry is GeoJSON in jsonb (no PostGIS needed).

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

alter table developments
  add column if not exists map_appearance jsonb not null
  default '{"basemap":"custom","terrain":true,"terrainExaggeration":1.5}'::jsonb;

alter table developments
  add column if not exists view_locked boolean not null default false;

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
