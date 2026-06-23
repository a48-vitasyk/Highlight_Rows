-- ZomBro AI handoffs — спільний пул хендофів бота (для команди).
-- Модель: як public.awaiting_reply (спільний список тікетів) + «взяв» із reminders
-- (owner_email/owner_uid/taken_at). «Відписав» = DELETE рядка (прибрати для всіх).
--
-- Застосувати ВРУЧНУ: Supabase → проєкт wxiuucxzxhzctawzgqrr → SQL Editor.
-- УВАГА: RLS нижче — стандартна «вся залогінена команда має повний доступ».
-- Звір її з реальними політиками awaiting_reply (запит у кінці файлу) і за потреби
-- підправ, щоб збігалося з тим, як уже працює awaiting_reply.

create table if not exists public.ai_handoffs (
    id                 uuid primary key default gen_random_uuid(),
    ticket_id          text not null unique,        -- № тікета (merge-duplicates по ньому)
    sig                text,                         -- хеш summary: новий хендоф = нова sig
    subject            text default '',
    url                text default '',
    detected_at        timestamptz default now(),
    detected_by_email  text,                         -- хто перший побачив
    owner_email        text,                         -- хто «взяв»
    owner_uid          uuid,
    taken_at           timestamptz,
    updated_at         timestamptz default now()
);

alter table public.ai_handoffs enable row level security;

-- Повний доступ для залогінених (спільна командна таблиця, як awaiting_reply).
drop policy if exists "ai_handoffs auth all" on public.ai_handoffs;
create policy "ai_handoffs auth all" on public.ai_handoffs
    for all to authenticated using (true) with check (true);

-- Realtime: щоб зміни миттєво розліталися командою (postgres_changes).
-- Якщо публікація supabase_realtime вже FOR ALL TABLES — цей рядок пропусти.
alter publication supabase_realtime add table public.ai_handoffs;

-- ── Звірка з awaiting_reply (виконай окремо й порівняй політики) ──────────
-- select polname, polcmd,
--        pg_get_expr(polqual, polrelid)      as using_expr,
--        pg_get_expr(polwithcheck, polrelid) as check_expr
-- from pg_policy where polrelid = 'public.awaiting_reply'::regclass;
