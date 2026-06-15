-- Highlight Rows — фаза 14: захист шаблонів від видалення (soft-delete).
-- Створювати/редагувати можуть усі з домену; «видалення» стає позначкою
-- archived=true (оборотне, відновлюється в UI). Жорсткий DELETE через API
-- заборонено всім — лишається тільки в Supabase (service_role у дашборді).
-- Застосувати у Supabase → SQL Editor (ідемпотентно).
-- ⚠️ ПЕРЕД застосуванням замініть «your-domain.example» на ваш реальний домен
--    (так само, як у міграції 0011).

alter table public.snippets add column if not exists archived boolean not null default false;

-- Розбиваємо blanket-політику "snip write" (for all) на окремі select/insert/update.
-- DELETE-політику навмисно НЕ створюємо → жорстке видалення через API недоступне.
drop policy if exists "snip write"   on public.snippets;
drop policy if exists "snip read"    on public.snippets;
drop policy if exists "snip insert"  on public.snippets;
drop policy if exists "snip update"  on public.snippets;

create policy "snip read" on public.snippets for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );
create policy "snip insert" on public.snippets for insert to authenticated
    with check ( auth.email() ~* '@your-domain\.example$' );
create policy "snip update" on public.snippets for update to authenticated
    using ( auth.email() ~* '@your-domain\.example$' )
    with check ( auth.email() ~* '@your-domain\.example$' );
