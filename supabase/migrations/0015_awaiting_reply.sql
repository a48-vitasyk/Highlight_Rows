-- Highlight Rows — фаза 15: «Клієнт чекає на відповідь».
-- Спільний пул тікетів, де клієнт відповів, а підтримка ще ні. Один рядок на
-- тікет (ticket_id unique). Resolve = DELETE; тригер пише час до відповіді в
-- awaiting_logs (для щоденної статистики). Застосувати у Supabase → SQL Editor.
-- ⚠️ ПЕРЕД застосуванням замініть «your-domain.example» на ваш домен (як у 0011).

create table if not exists public.awaiting_reply (
    id uuid primary key default gen_random_uuid(),
    ticket_id text not null unique,                 -- ключ дедупу між виявлювачами
    client_message_at timestamptz not null,         -- час останнього повідомлення клієнта (старт очікування)
    subject text default '',
    owner_email text,                               -- авто-власник (перший виявлювач)
    owner_uid uuid,
    created_by uuid default auth.uid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.awaiting_reply enable row level security;

drop policy if exists "aw read"   on public.awaiting_reply;
drop policy if exists "aw insert" on public.awaiting_reply;
drop policy if exists "aw update" on public.awaiting_reply;
drop policy if exists "aw delete" on public.awaiting_reply;
create policy "aw read" on public.awaiting_reply for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );
create policy "aw insert" on public.awaiting_reply for insert to authenticated
    with check ( auth.email() ~* '@your-domain\.example$' );
create policy "aw update" on public.awaiting_reply for update to authenticated
    using ( auth.email() ~* '@your-domain\.example$' ) with check ( auth.email() ~* '@your-domain\.example$' );
create policy "aw delete" on public.awaiting_reply for delete to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );

drop trigger if exists awaiting_touch on public.awaiting_reply;
create trigger awaiting_touch before update on public.awaiting_reply
    for each row execute function public.touch_updated_at();  -- функція з 0001

-- Журнал часу відповіді (лише тригерний запис; читання — за доменом).
create table if not exists public.awaiting_logs (
    id uuid primary key default gen_random_uuid(),
    ticket_id text,
    owner_email text,
    responder_email text,
    responder_uid uuid,
    waited_ms bigint,
    at timestamptz not null default now()
);
alter table public.awaiting_logs enable row level security;
drop policy if exists "aw logs read" on public.awaiting_logs;
create policy "aw logs read" on public.awaiting_logs for select to authenticated
    using ( auth.email() ~* '@your-domain\.example$' );
create index if not exists awaiting_logs_at_idx on public.awaiting_logs (at desc);

-- На resolve (DELETE) фіксуємо час до першої відповіді й хто відповів.
create or replace function public.log_awaiting_resolve() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    insert into public.awaiting_logs(ticket_id, owner_email, responder_email, responder_uid, waited_ms)
    values (old.ticket_id, old.owner_email, auth.email(), auth.uid(),
            (extract(epoch from (now() - old.client_message_at)) * 1000)::bigint);
    return null;
end $$;
drop trigger if exists awaiting_resolve_log on public.awaiting_reply;
create trigger awaiting_resolve_log after delete on public.awaiting_reply
    for each row execute function public.log_awaiting_resolve();

-- Тригерну функцію не можна викликати напряму через API.
revoke execute on function public.log_awaiting_resolve() from anon, authenticated;

-- Realtime — щоб команда бачила зміни миттєво.
do $$ begin
    alter publication supabase_realtime add table public.awaiting_reply;
exception when duplicate_object then null; end $$;
