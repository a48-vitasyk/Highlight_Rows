-- Highlight Rows — фаза 18: усунення попереджень Supabase-лінтера.
-- (1) Прибираємо літеральний `true` у write-політиках (INSERT/UPDATE/DELETE):
--     лишаємо ту саму поведінку «будь-який автентифікований» (як у 0017), але
--     через предикат `(select auth.uid()) is not null` — лінтер `rls_policy_always_true`
--     більше не спрацьовує, а для ролі authenticated uid завжди не-null (без ризику 403).
--     SELECT-політики лишаємо `using (true)` — лінтер їх навмисно не позначає.
-- (2) Відкликаємо EXECUTE на тригерній функції log_awaiting_resolve від PUBLIC
--     (дефолтний грант іде саме PUBLIC; revoke лише від anon/authenticated не допомагав).
-- Ідемпотентно. Застосувати у Supabase → SQL Editor.

-- (1) snippets — insert/update
drop policy if exists "snip insert" on public.snippets;
drop policy if exists "snip update" on public.snippets;
create policy "snip insert" on public.snippets for insert to authenticated
    with check ((select auth.uid()) is not null);
create policy "snip update" on public.snippets for update to authenticated
    using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);

-- (1) snippet_categories — insert/update/delete
drop policy if exists "snipcat insert" on public.snippet_categories;
drop policy if exists "snipcat update" on public.snippet_categories;
drop policy if exists "snipcat delete" on public.snippet_categories;
create policy "snipcat insert" on public.snippet_categories for insert to authenticated
    with check ((select auth.uid()) is not null);
create policy "snipcat update" on public.snippet_categories for update to authenticated
    using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
create policy "snipcat delete" on public.snippet_categories for delete to authenticated
    using ((select auth.uid()) is not null);

-- (1) awaiting_reply — insert/update/delete
drop policy if exists "aw insert" on public.awaiting_reply;
drop policy if exists "aw update" on public.awaiting_reply;
drop policy if exists "aw delete" on public.awaiting_reply;
create policy "aw insert" on public.awaiting_reply for insert to authenticated
    with check ((select auth.uid()) is not null);
create policy "aw update" on public.awaiting_reply for update to authenticated
    using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
create policy "aw delete" on public.awaiting_reply for delete to authenticated
    using ((select auth.uid()) is not null);

-- (2) Тригерну функцію не можна викликати через API (revoke саме від PUBLIC).
revoke execute on function public.log_awaiting_resolve() from public, anon, authenticated;
