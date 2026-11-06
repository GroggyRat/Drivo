-- Shifts started from the Drivo app's Clock in. On its own so the new value
-- is committed before 20261106000001 uses it.
alter type public.shift_source add value if not exists 'drivo';
