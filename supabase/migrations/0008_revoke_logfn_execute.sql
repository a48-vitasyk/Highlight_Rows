-- Highlight Rows — гартування за Security Advisor.
-- Аудит-тригер log_reminder_change() (SECURITY DEFINER, з 0004) не повинен бути
-- доступним як RPC через /rest/v1/rpc/. Тригер reminders_log спрацьовує без права
-- EXECUTE (Postgres його для тригерів не перевіряє), тож відкликання нічого не ламає.
-- Застосувати у Supabase → SQL Editor (ідемпотентно).

revoke execute on function public.log_reminder_change() from public;
revoke execute on function public.log_reminder_change() from anon;
revoke execute on function public.log_reminder_change() from authenticated;
