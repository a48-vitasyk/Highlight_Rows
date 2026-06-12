-- Highlight Rows — фаза 5: HeartBeat «Взяти / Відписав» (передача зміни).
-- owner_* — хто взяв; done_* — хто закрив. Логіка дзвінка — у плагіні.
-- Застосувати у Supabase → SQL Editor (ідемпотентно).

alter table public.reminders add column if not exists owner_email text;
alter table public.reminders add column if not exists owner_uid uuid;
alter table public.reminders add column if not exists taken_at timestamptz;
alter table public.reminders add column if not exists done_at timestamptz;
alter table public.reminders add column if not exists done_by_email text;

-- Розширюємо аудит-тригер: логуємо «взяв» / «віддав» / «відписав» / «знову відкрив».
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
                    coalesce(old.scope, '') || ' -> ' || new.scope, a_uid, a_email);
        end if;
        if new.owner_email is distinct from old.owner_email then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.owner_email is not null then 'claim' else 'release' end,
                    'owner=' || coalesce(new.owner_email, '-'), a_uid, a_email);
        end if;
        if new.done_at is distinct from old.done_at then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.done_at is not null then 'done' else 'reopen' end,
                    'by=' || coalesce(new.done_by_email, '-'), a_uid, a_email);
        end if;
        if new.muted_date is distinct from old.muted_date then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.muted_date is not null then 'mute' else 'unmute' end,
                    'muted_date=' || coalesce(new.muted_date, '-'), a_uid, a_email);
        end if;
        if new.snooze_until is distinct from old.snooze_until then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, case when new.snooze_until is not null then 'snooze' else 'snooze_clear' end,
                    'until=' || coalesce(new.snooze_until::text, '-'), a_uid, a_email);
        end if;
        if (new."time" is distinct from old."time")
           or (new.note is distinct from old.note)
           or (new.ticket_id is distinct from old.ticket_id) then
            insert into public.reminder_logs(reminder_id, ticket_id, action, details, actor_uid, actor_email)
            values (rid, tkt, 'edit',
                    'time ' || coalesce(old."time", '') || '->' || new."time", a_uid, a_email);
        end if;
    end if;

    return null;
end $$;

alter function public.log_reminder_change() set search_path = '';
