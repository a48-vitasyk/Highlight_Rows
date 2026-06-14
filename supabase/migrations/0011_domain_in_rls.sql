-- Highlight Rows — фаза 11: перевірка домену @your-domain.example у самих RLS-політиках.
-- Другий рубіж захисту: навіть якщо акаунт НЕ з домену якось отримає сесію,
-- сама БД відмовить у читанні/записі. Застосувати у Supabase → SQL Editor.

-- reminders: зберігаємо логіку scope/власника (з 0002), додаємо домен.
drop policy if exists "read"        on public.reminders;
drop policy if exists "insert"      on public.reminders;
drop policy if exists "update"      on public.reminders;
drop policy if exists "delete"      on public.reminders;
drop policy if exists "auth read"   on public.reminders;
drop policy if exists "auth insert" on public.reminders;
drop policy if exists "auth update" on public.reminders;
drop policy if exists "auth delete" on public.reminders;

create policy "read" on public.reminders for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' and (scope = 'shared' or created_by = auth.uid()) );
create policy "insert" on public.reminders for insert to authenticated
    with check ( auth.email() ~* '@your-domain\.example$' and created_by = auth.uid() );
create policy "update" on public.reminders for update to authenticated
    using ( auth.email() ~* '@your-domain\.example$' and (scope = 'shared' or created_by = auth.uid()) );
create policy "delete" on public.reminders for delete to authenticated
    using ( auth.email() ~* '@your-domain\.example$' and (scope = 'shared' or created_by = auth.uid()) );

-- reminder_logs: лише читання — додаємо домен.
drop policy if exists "logs read" on public.reminder_logs;
create policy "logs read" on public.reminder_logs for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );

-- snippets: командна бібліотека — лише для домену.
drop policy if exists "snip read"  on public.snippets;
drop policy if exists "snip write" on public.snippets;
create policy "snip read" on public.snippets for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );
create policy "snip write" on public.snippets for all to authenticated
    using ( auth.email() ~* '@your-domain\.example$' ) with check ( auth.email() ~* '@your-domain\.example$' );

-- snippet_categories: те саме.
drop policy if exists "snipcat read"  on public.snippet_categories;
drop policy if exists "snipcat write" on public.snippet_categories;
create policy "snipcat read" on public.snippet_categories for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );
create policy "snipcat write" on public.snippet_categories for all to authenticated
    using ( auth.email() ~* '@your-domain\.example$' ) with check ( auth.email() ~* '@your-domain\.example$' );
