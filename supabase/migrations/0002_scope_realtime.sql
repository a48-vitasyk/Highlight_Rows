-- Highlight Rows — фаза 2: особисті/загальні будильники + Realtime.
-- Застосувати у SQL Editor (ідемпотентно).

-- scope: 'personal' (бачить лише автор) / 'shared' (бачать усі). За замовч. personal.
alter table public.reminders add column if not exists scope text not null default 'personal';
alter table public.reminders add column if not exists created_by_email text;

do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'reminders_scope_chk') then
        alter table public.reminders add constraint reminders_scope_chk check (scope in ('personal', 'shared'));
    end if;
end $$;

-- Scope-залежний RLS: особисті — лише автор; загальні — усі автентифіковані.
drop policy if exists "auth read"   on public.reminders;
drop policy if exists "auth insert" on public.reminders;
drop policy if exists "auth update" on public.reminders;
drop policy if exists "auth delete" on public.reminders;
drop policy if exists "read"   on public.reminders;
drop policy if exists "insert" on public.reminders;
drop policy if exists "update" on public.reminders;
drop policy if exists "delete" on public.reminders;
create policy "read"   on public.reminders for select to authenticated using (scope = 'shared' or created_by = auth.uid());
create policy "insert" on public.reminders for insert to authenticated with check (created_by = auth.uid());
create policy "update" on public.reminders for update to authenticated using (scope = 'shared' or created_by = auth.uid());
create policy "delete" on public.reminders for delete to authenticated using (scope = 'shared' or created_by = auth.uid());

-- Realtime: додати таблицю в публікацію (для postgres_changes).
do $$ begin
    alter publication supabase_realtime add table public.reminders;
exception when duplicate_object then null; end $$;
