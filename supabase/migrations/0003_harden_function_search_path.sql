-- Highlight Rows — гартування за Security Advisor (function_search_path_mutable).
-- Фіксуємо search_path тригерних функцій. Вони використовують лише вбудовані
-- (now(), регекс-оператор) — порожній search_path безпечний. Ідемпотентно.

alter function public.touch_updated_at() set search_path = '';
alter function public.enforce_domain() set search_path = '';
