-- Highlight Rows — фаза 8: мовні версії шаблонів (RU/EN).
-- Основне тіло (body) лишається мовою за замовчуванням (UA). Якщо переклад
-- порожній — підставляється body. Застосувати у Supabase → SQL Editor.

alter table public.snippets add column if not exists body_ru text;
alter table public.snippets add column if not exists body_en text;
