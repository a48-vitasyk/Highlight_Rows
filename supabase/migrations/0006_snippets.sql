-- Highlight Rows — фаза 6: спільна бібліотека шаблонів відповідей.
-- Застосувати у Supabase → SQL Editor (ідемпотентно).

create table if not exists public.snippets (
    id uuid primary key default gen_random_uuid(),
    title text not null default '',
    body text not null default '',
    created_by_email text,
    sort int not null default 0,
    updated_at timestamptz not null default now()
);

alter table public.snippets enable row level security;

-- Командна бібліотека: читають і редагують усі автентифіковані.
drop policy if exists "snip read"  on public.snippets;
drop policy if exists "snip write" on public.snippets;
create policy "snip read"  on public.snippets for select to authenticated using (true);
create policy "snip write" on public.snippets for all to authenticated using (true) with check (true);

-- updated_at автооновлення (функція з 0001).
drop trigger if exists snippets_touch on public.snippets;
create trigger snippets_touch before update on public.snippets
    for each row execute function public.touch_updated_at();

-- Realtime (необовʼязково для шаблонів, але хай буде).
do $$ begin
    alter publication supabase_realtime add table public.snippets;
exception when duplicate_object then null; end $$;
