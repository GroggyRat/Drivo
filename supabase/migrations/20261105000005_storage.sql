-- Private Storage buckets. Every file path starts with the tenant id:
--   location-photos/<tenant_id>/<location or upload id>.jpg
--   delivery-proofs/<tenant_id>/<stop_id>/photo.jpg and signature.png
-- People can read and upload only inside their own tenants' folders.
-- Files are never overwritten or deleted by people; the server cleans up.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('location-photos', 'location-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('delivery-proofs', 'delivery-proofs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Members read their tenant's Drivo files" on storage.objects
  for select to authenticated using (
    bucket_id in ('location-photos', 'delivery-proofs')
    and (storage.foldername(name))[1] = any ((select app.member_tenant_ids())::text[])
  );

create policy "Members upload to their tenant's Drivo folders" on storage.objects
  for insert to authenticated with check (
    bucket_id in ('location-photos', 'delivery-proofs')
    and (storage.foldername(name))[1] = any ((select app.member_tenant_ids())::text[])
  );
