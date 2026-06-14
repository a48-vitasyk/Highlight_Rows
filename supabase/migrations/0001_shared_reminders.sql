-- Highlight Rows — спільна база будильників.
-- Застосувати у Supabase-проєкті: SQL Editor, `supabase db push`,
-- або MCP apply_migration. Ідемпотентно (можна виконувати повторно).

create table if not exists public.reminders (
    id uuid primary key default gen_random_uuid(),
    ticket_id text not null,
    "time" text not null,            -- "HH:MM"
    note text not null default '',
    muted_date text,                 -- "Y-M-D", коли заглушено (спільне)
    snooze_until timestamptz,        -- до коли діє снуз (спільне)
    created_by uuid references auth.users(id) default auth.uid(),
    updated_at timestamptz not null default now()
);

alter table public.reminders enable row level security;

-- Спільний пул: будь-який автентифікований читає/пише все.
drop policy if exists "auth read"   on public.reminders;
drop policy if exists "auth insert" on public.reminders;
drop policy if exists "auth update" on public.reminders;
drop policy if exists "auth delete" on public.reminders;
create policy "auth read"   on public.reminders for select to authenticated using (true);
create policy "auth insert" on public.reminders for insert to authenticated with check (true);
create policy "auth update" on public.reminders for update to authenticated using (true);
create policy "auth delete" on public.reminders for delete to authenticated using (true);

-- Автооновлення updated_at при кожній зміні рядка.
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end $$;
drop trigger if exists reminders_touch on public.reminders;
create trigger reminders_touch before update on public.reminders
    for each row execute function public.touch_updated_at();

-- Дозволяти реєстрацію лише акаунтам корпоративного домену.
-- ⚠️ Замініть «your-domain.example» на ваш реальний домен перед застосуванням.
create or replace function public.enforce_domain() returns trigger language plpgsql as $$
begin
    if new.email !~* '@your-domain\.example$' then
        raise exception 'Only @your-domain.example accounts are allowed';
    end if;
    return new;
end $$;
drop trigger if exists enforce_domain on auth.users;
create trigger enforce_domain before insert on auth.users
    for each row execute function public.enforce_domain();
