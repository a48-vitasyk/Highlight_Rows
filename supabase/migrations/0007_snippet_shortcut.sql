-- Highlight Rows — фаза 7: скорочення (тригер) для шаблонів відповідей.
-- Застосувати у Supabase → SQL Editor (ідемпотентно).

alter table public.snippets add column if not exists shortcut text;
