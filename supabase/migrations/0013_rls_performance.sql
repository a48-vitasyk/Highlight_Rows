-- Highlight Rows — фаза 13: оптимізація RLS (закриває PERFORMANCE-попередження
-- Advisor після 0011).
--  1) auth.<fn>() → (select auth.<fn>()): обчислюється раз на запит, а не на рядок.
--  2) на snippets/snippet_categories політику FOR ALL ("...write") розділяємо на
--     insert/update/delete, щоб не було двох permissive-політик для SELECT.
-- Застосувати у Supabase → SQL Editor.

-- ── reminders (4 окремі політики, лише обгортаємо у select) ──────────────
drop policy if exists "read"   on public.reminders;
drop policy if exists "insert" on public.reminders;
drop policy if exists "update" on public.reminders;
drop policy if exists "delete" on public.reminders;

create policy "read" on public.reminders for select to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' and (scope = 'shared' or created_by = (select auth.uid())) );
create policy "insert" on public.reminders for insert to authenticated
    with check ( (select auth.email()) ~* '@zomro\.org$' and created_by = (select auth.uid()) );
create policy "update" on public.reminders for update to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' and (scope = 'shared' or created_by = (select auth.uid())) );
create policy "delete" on public.reminders for delete to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' and (scope = 'shared' or created_by = (select auth.uid())) );

-- ── reminder_logs (лише читання) ─────────────────────────────────────────
drop policy if exists "logs read" on public.reminder_logs;
create policy "logs read" on public.reminder_logs for select to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' );

-- ── snippets: read + окремі insert/update/delete (без FOR ALL) ───────────
drop policy if exists "snip read"   on public.snippets;
drop policy if exists "snip write"  on public.snippets;
drop policy if exists "snip insert" on public.snippets;
drop policy if exists "snip update" on public.snippets;
drop policy if exists "snip delete" on public.snippets;

create policy "snip read" on public.snippets for select to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' );
create policy "snip insert" on public.snippets for insert to authenticated
    with check ( (select auth.email()) ~* '@zomro\.org$' );
create policy "snip update" on public.snippets for update to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' ) with check ( (select auth.email()) ~* '@zomro\.org$' );
create policy "snip delete" on public.snippets for delete to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' );

-- ── snippet_categories: те саме ──────────────────────────────────────────
drop policy if exists "snipcat read"   on public.snippet_categories;
drop policy if exists "snipcat write"  on public.snippet_categories;
drop policy if exists "snipcat insert" on public.snippet_categories;
drop policy if exists "snipcat update" on public.snippet_categories;
drop policy if exists "snipcat delete" on public.snippet_categories;

create policy "snipcat read" on public.snippet_categories for select to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' );
create policy "snipcat insert" on public.snippet_categories for insert to authenticated
    with check ( (select auth.email()) ~* '@zomro\.org$' );
create policy "snipcat update" on public.snippet_categories for update to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' ) with check ( (select auth.email()) ~* '@zomro\.org$' );
create policy "snipcat delete" on public.snippet_categories for delete to authenticated
    using ( (select auth.email()) ~* '@zomro\.org$' );

-- ── INFO: індекс під зовнішній ключ reminders.created_by ─────────────────
create index if not exists reminders_created_by_idx on public.reminders (created_by);
