-- Highlight Rows — фаза 9: категорії шаблонів (для групування й пошуку).
-- Порожня категорія → група «Без категорії». Застосувати у Supabase → SQL Editor.

alter table public.snippets add column if not exists category text;
