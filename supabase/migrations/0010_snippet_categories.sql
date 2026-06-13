-- Highlight Rows — фаза 10: спільний список категорій шаблонів.
-- Категорії стають окремими сутностями (можна створювати наперед, не прив'язуючи
-- до шаблону). Застосувати у Supabase → SQL Editor (ідемпотентно).

create table if not exists public.snippet_categories (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_by_email text,
    created_at timestamptz not null default now()
);

-- Без дублів за назвою (регістр важливий — як ввели).
create unique index if not exists snippet_categories_name_uniq on public.snippet_categories (name);

alter table public.snippet_categories enable row level security;

-- Командна бібліотека: читають і редагують усі автентифіковані.
drop policy if exists "snipcat read"  on public.snippet_categories;
drop policy if exists "snipcat write" on public.snippet_categories;
create policy "snipcat read"  on public.snippet_categories for select to authenticated using (true);
create policy "snipcat write" on public.snippet_categories for all to authenticated using (true) with check (true);

do $$ begin
    alter publication supabase_realtime add table public.snippet_categories;
exception when duplicate_object then null; end $$;
