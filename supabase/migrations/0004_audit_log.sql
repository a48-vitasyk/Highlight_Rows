-- Highlight Rows — фаза 4: журнал дій над будильниками (аудит).
-- Логування на стороні БД (тригер) — фіксує всі зміни незалежно від клієнта,
-- автора беремо з JWT (підробити не можна). Застосувати у Supabase → SQL Editor
-- (ідемпотентно).

create table if not exists public.reminder_logs (
    id uuid primary key default gen_random_uuid(),
    reminder_id uuid,                -- без FK: рядок журналу переживає видалення будильника
    ticket_id text,
    action text not null,            -- create | edit | scope_shared | scope_personal | mute | unmute | snooze | snooze_clear | delete
    details text,                    -- людиночитний підсумок / old → new
    actor_uid uuid,
    actor_email text,
    at timestamptz not null default now()
);

alter table public.reminder_logs enable row level security;

-- Історію читає будь-який автентифікований; писати/міняти не може ніхто —
-- рядки додає лише тригер (security definer). Журнал незмінний.
drop policy if exists "logs read" on public.reminder_logs;
create policy "logs read" on public.reminder_logs for select to authenticated using (true);

create index if not exists reminder_logs_at_idx on public.reminder_logs (at desc);
create index if not exists reminder_logs_ticket_idx on public.reminder_logs (ticket_id);

create or replace function public.log_reminder_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    a_uid uuid := auth.uid();
    a_email text := auth.email();
    rid uuid;
    tkt text;
begin
    if tg_op = 'DELETE' then rid := old.id; tkt := old.ticket_id;
    else rid := new.id; tkt := new.ticket_id; end if;

    if tg_op = 'INSERT' then
        insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
        values (rid, tkt, 'create', 'time=' || new."time" || ' scope=' || new.scope, a_uid, a_email);

    elsif tg_op = 'DELETE' then
        insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
        values (rid, tkt, 'delete', 'time=' || old."time" || ' scope=' || old.scope, a_uid, a_email);

    else  -- UPDATE: окремий запис на кожен змінений аспект
        if new.scope is distinct from old.scope then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.scope = 'shared' then 'scope_shared' else 'scope_personal' end,
                    coalesce(old.scope, '∅') || ' → ' || new.scope, a_uid, a_email);
        end if;
        if new.muted_date is distinct from old.muted_date then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.muted_date is not null then 'mute' else 'unmute' end,
                    'muted_date=' || coalesce(new.muted_date, '∅'), a_uid, a_email);
        end if;
        if new.snooze_until is distinct from old.snooze_until then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.snooze_until is not null then 'snooze' else 'snooze_clear' end,
                    'until=' || coalesce(new.snooze_until::text, '∅'), a_uid, a_email);
        end if;
        if (new."time" is distinct from old."time")
           or (new.note is distinct from old.note)
           or (new.ticket_id is distinct from old.ticket_id) then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, 'edit',
                    'time ' || coalesce(old."time", '∅') || '→' || new."time"
                    || case when new.ticket_id is distinct from old.ticket_id
                            then '; ticket ' || coalesce(old.ticket_id, '∅') || '→' || new.ticket_id else '' end,
                    a_uid, a_email);
        end if;
    end if;

    return null;  -- AFTER-тригер
end $$;

alter function public.log_reminder_change() set search_path = '';

drop trigger if exists reminders_log on public.reminders;
create trigger reminders_log after insert or update or delete on public.reminders
    for each row execute function public.log_reminder_change();
