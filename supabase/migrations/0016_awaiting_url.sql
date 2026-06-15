-- Highlight Rows — фаза 16: URL тікета у спільному пулі «клієнт чекає».
-- Потрібен, щоб блок «Клієнт чекає» в попапі відкривав тікет (попап не знає
-- origin панелі; content.js будує повний URL із location.origin при upsert).
-- Застосувати у Supabase → SQL Editor (ідемпотентно).

alter table public.awaiting_reply add column if not exists url text;
