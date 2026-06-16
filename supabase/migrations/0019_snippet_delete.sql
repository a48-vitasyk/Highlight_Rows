-- Highlight Rows — фаза 19: дозволити жорстке видалення шаблонів.
-- Потрібне для кнопки «Видалити назавжди» в розділі «Архів» (з підтвердженням
-- у UI). Звичайне «видалення» зі списку лишається soft-delete (archived=true);
-- жорсткий DELETE — лише свідомий, з архіву. Предикат не літеральний `true`,
-- щоб не спрацьовував лінтер. Ідемпотентно. Застосувати у Supabase → SQL Editor.

drop policy if exists "snip delete" on public.snippets;
create policy "snip delete" on public.snippets for delete to authenticated
    using ((select auth.uid()) is not null);
