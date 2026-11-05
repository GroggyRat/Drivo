# Integrations

**Status: draft.** This is the contract we plan to build in Milestone 8. It is here early so the BillZilla and KaiWorkforce sides can be planned. Field names may still change before then; changes will be listed at the bottom.

Integrations are optional per tenant. A tenant without BillZilla adds orders in Drivo; a tenant without KaiWorkforce is tracked from route start to the last stop.

## Linking a tenant

A KaiTech platform owner links a Drivo tenant to its BillZilla organisation and KaiWorkforce company (`platform_link_tenant`). Each link gets its own webhook secret. Drivo drivers are matched to KaiWorkforce employees by `kaiworkforce_employee_id`, set by the tenant's Admin.

## Signing and delivery rules (all webhooks, both directions)

Every request carries:

| Header | Value |
|---|---|
| `X-KaiTech-Event` | Event name, for example `invoice.confirmed` |
| `X-KaiTech-Delivery` | Unique id for this delivery (UUID). The receiver ignores ids it has already processed. |
| `X-KaiTech-Timestamp` | Unix seconds when sent. Requests older than 5 minutes are refused. |
| `X-KaiTech-Signature` | `v1=` followed by hex HMAC-SHA256 of `<timestamp>.<raw body>` with the link's secret |

- The body is JSON, UTF-8. Times are ISO 8601 with offset. Money is a decimal string with a currency code.
- Reply `2xx` when stored. Anything else is retried with backoff (1 min, 5 min, 30 min, 2 h, 12 h), then flagged in the sender's admin screen.
- Compare signatures in constant time.

## BillZilla to Drivo

### `POST /api/integrations/billzilla/webhook`

#### `invoice.confirmed`

Sent when an invoice is confirmed and should be delivered. Sending it again for the same invoice updates it.

```json
{
  "event": "invoice.confirmed",
  "organisation_id": "bz-demo-nadera",
  "invoice": {
    "id": "bz-inv-10231",
    "number": "INV-10231",
    "status": "confirmed",
    "confirmed_at": "2026-11-05T09:12:00+12:00",
    "currency": "FJD",
    "total": "217.50",
    "cartons": 11,
    "customer": {
      "id": "BZ-CUST-2001",
      "name": "Cumming Street Mart",
      "phone": "+679 000 0000",
      "address": "Cumming Street, Suva"
    },
    "lines": [
      { "sku": "RICE-10", "description": "Rice 10 kg", "quantity": 3, "unit": "bag" }
    ],
    "url": "https://billzilla.example/invoices/bz-inv-10231"
  }
}
```

Drivo stores or updates the customer and the order (`source = billzilla`). If the customer has no approved location, the order shows "Needs a pin" and cannot be added to a route.

#### `invoice.cancelled`

```json
{ "event": "invoice.cancelled", "organisation_id": "bz-demo-nadera", "invoice": { "id": "bz-inv-10231", "cancelled_at": "2026-11-05T10:00:00+12:00" } }
```

Drivo marks the order cancelled and removes it from any route that has not started. If the route is in progress, the dispatcher is alerted.

#### `customer.updated`

```json
{ "event": "customer.updated", "organisation_id": "bz-demo-nadera", "customer": { "id": "BZ-CUST-2001", "name": "Cumming Street Mart", "phone": "+679 000 0000", "address": "Cumming Street, Suva" } }
```

### Manual pull: "Sync from BillZilla"

Drivo calls BillZilla:

`GET {billzilla}/api/v1/invoices?status=confirmed&delivery_status=pending&updated_since=<ISO time>&cursor=<cursor>`

Authenticated with the same HMAC headers (empty body). Response:

```json
{ "invoices": [ { "...": "same shape as invoice above" } ], "next_cursor": null }
```

## Drivo to BillZilla

### `POST {billzilla}/api/v1/invoices/{invoice_id}/delivery`

Sent when a stop is completed (delivered, partly delivered or failed), with the HMAC headers and event `delivery.updated`.

```json
{
  "event": "delivery.updated",
  "organisation_id": "bz-demo-nadera",
  "invoice_id": "bz-inv-10231",
  "status": "delivered",
  "delivered_at": "2026-11-05T11:42:10+12:00",
  "received_by": "Shop manager",
  "delivered_in_full": true,
  "notes": null,
  "driver_name": "Jone Vakacegu",
  "vehicle_plate": "FT 482",
  "proof": {
    "photo_url": "https://drivo.example/p/<signed token>",
    "signature_url": "https://drivo.example/p/<signed token>",
    "expires_at": "2026-12-05T11:42:10+12:00"
  }
}
```

`status` is one of `delivered`, `partially_delivered` or `failed`. Proof links are signed and expire after 30 days; BillZilla should copy the files if it needs them longer.

## KaiWorkforce to Drivo

### `POST /api/integrations/kaiworkforce/webhook`

#### `shift.clock_in`

```json
{
  "event": "shift.clock_in",
  "company_id": "kw-demo-nadera",
  "employee_id": "KW-EMP-1001",
  "shift_id": "kw-shift-88123",
  "at": "2026-11-05T07:45:00+12:00"
}
```

If the employee is an active Drivo driver in that tenant, Drivo opens a shift and the driver app starts tracking (through a push message and on next app open). Unknown employees are ignored and logged.

#### `shift.clock_out`

Same shape with event `shift.clock_out`. Drivo closes the shift and the app stops tracking.

## Single sign-on (Milestone 8)

Drivo keeps its own sign-in. Linking a KaiTech account is optional. The plan for Android is in `docs/decisions.md` ("Continue as" on Android) and will be written up in full here before it is built.

## Changes

None yet.
