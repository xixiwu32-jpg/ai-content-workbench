create extension if not exists pgcrypto;

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  title text not null,
  short_title text,
  url text,
  platform text not null default 'gzh',
  value_label text not null default '未标注',
  heat_label text not null default '未标注',
  priority_label text not null default '未标注',
  link_status text not null default '未标注',
  status text not null default 'todo' check (status in ('todo', 'rewritten', 'archived', 'candidate')),
  folder_name text,
  source text,
  source_text text,
  report_md text,
  raw jsonb not null default '{}'::jsonb,
  rewritten_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_materials_status_created_at on public.materials (status, created_at desc);
create index if not exists idx_materials_platform on public.materials (platform);
create index if not exists idx_materials_value_label on public.materials (value_label);
create index if not exists idx_materials_priority_label on public.materials (priority_label);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  material_id uuid references public.materials(id) on delete set null,
  source_type text,
  source_value text,
  title text,
  summary text,
  tags jsonb not null default '[]'::jsonb,
  cards jsonb not null default '[]'::jsonb,
  markdown text,
  provider text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_generations_material_id on public.generations (material_id);
create index if not exists idx_generations_created_at on public.generations (created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_materials_updated_at on public.materials;
create trigger trg_materials_updated_at
before update on public.materials
for each row
execute function public.set_updated_at();
