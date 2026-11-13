-- Xero as a source of customers and invoices. On its own so the new value is
-- committed before the next migration uses it.
alter type public.record_source add value if not exists 'xero';
