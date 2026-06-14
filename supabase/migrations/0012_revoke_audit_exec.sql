-- Highlight Rows — фаза 12: аудит-функція не має бути викликна напряму через API.
-- public.log_reminder_change() — це SECURITY DEFINER тригер-функція (пише незмінний
-- reminder_logs). Вона має спрацьовувати ЛИШЕ з тригера на reminders, а не як RPC.
-- Тригери в Postgres не перевіряють право EXECUTE, тож відкликання нічого не ламає.
-- Застосувати у Supabase → SQL Editor.

revoke execute on function public.log_reminder_change() from public;
revoke execute on function public.log_reminder_change() from anon;
revoke execute on function public.log_reminder_change() from authenticated;
