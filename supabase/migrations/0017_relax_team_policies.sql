-- Highlight Rows — фаза 17: політики БЕЗ прив'язки до домену.
-- Для команд без корпоративного домену (вхід лише через Google). Відновлює доступ,
-- який заблокували placeholder-домени «your-domain.example» у міграціях 0014/0015.
-- Доступ мають усі автентифіковані (як у 0006). Безпека — на рівні входу:
-- лишіть увімкненим ТІЛЬКИ Google-провайдер і за потреби вимкніть реєстрацію нових.
-- Ідемпотентно. Застосувати у Supabase → SQL Editor. Домен підставляти НЕ треба.

-- snippets (відмашки)
drop policy if exists "snip read"   on public.snippets;
drop policy if exists "snip insert" on public.snippets;
drop policy if exists "snip update" on public.snippets;
create policy "snip read"   on public.snippets for select to authenticated using (true);
create policy "snip insert" on public.snippets for insert to authenticated with check (true);
create policy "snip update" on public.snippets for update to authenticated using (true) with check (true);

-- snippet_categories
drop policy if exists "snipcat read"   on public.snippet_categories;
drop policy if exists "snipcat insert" on public.snippet_categories;
drop policy if exists "snipcat update" on public.snippet_categories;
drop policy if exists "snipcat delete" on public.snippet_categories;
create policy "snipcat read"   on public.snippet_categories for select to authenticated using (true);
create policy "snipcat insert" on public.snippet_categories for insert to authenticated with check (true);
create policy "snipcat update" on public.snippet_categories for update to authenticated using (true) with check (true);
create policy "snipcat delete" on public.snippet_categories for delete to authenticated using (true);

-- awaiting_reply («клієнт чекає»)
drop policy if exists "aw read"   on public.awaiting_reply;
drop policy if exists "aw insert" on public.awaiting_reply;
drop policy if exists "aw update" on public.awaiting_reply;
drop policy if exists "aw delete" on public.awaiting_reply;
create policy "aw read"   on public.awaiting_reply for select to authenticated using (true);
create policy "aw insert" on public.awaiting_reply for insert to authenticated with check (true);
create policy "aw update" on public.awaiting_reply for update to authenticated using (true) with check (true);
create policy "aw delete" on public.awaiting_reply for delete to authenticated using (true);

-- awaiting_logs (статистика часу до відповіді)
drop policy if exists "aw logs read" on public.awaiting_logs;
create policy "aw logs read" on public.awaiting_logs for select to authenticated using (true);
