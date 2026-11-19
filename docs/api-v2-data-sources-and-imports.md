# Data Sources and CSV import API

Base path: `/api/v1`. Session mutations require `X-CSRF-Token`.

## Data Sources

- `GET /data-sources?page=1&pageSize=25&sort=name&direction=asc&search=csv` returns a paginated `data.items` list and `data.pagination` metadata. Allowed sort fields: `name`, `type`, `status`, `createdAt`; page sizes are 25, 50, or 100.
- `POST /data-sources` accepts `{ "name": "Monthly CSV", "type": "CSV", "description": "Optional notes" }`.
- `PATCH /data-sources/{id}` accepts `description` (string or null), `status` (`ACTIVE` or `INACTIVE`), or both. Credential-managed legacy sources cannot be edited through this catalog.

Source types are `MANUAL`, `CSV`, `API`, and `SIMULATOR`. A disabled CSV source cannot create a new preview or confirm a preview.

## Multipart preview and confirmation

1. Send `POST /reading-imports/preview` as `multipart/form-data` with a `file` CSV part and a `sourceId` text part. Maximum upload size is 10 MB and maximum row count is 5,000.
2. The server validates the headers and every row, then saves the private CSV payload in a `PREVIEW` ImportJob. The response includes the job `id`, valid/rejected counts, and row errors. The stored CSV is omitted from list and detail responses.
3. Send `POST /reading-imports/{id}/confirm` with no body. The server verifies the source is still active, reparses and validates the saved CSV, then queues the import and returns HTTP 202. The worker persists accepted readings, quarantines invalid rows, and records the source and job references.

Accepted headers include `meterCode,timestamp,rawValue,unit,metric,externalReadingId`; `metric` and `externalReadingId` are optional. Existing `value` CSV headers remain supported. A source becoming inactive before confirmation returns HTTP 422; a conflicting concurrent state transition returns HTTP 409.

The legacy `POST /reading-imports` JSON `VALIDATE_ONLY`/`COMMIT` API remains available while callers migrate to the persisted preview flow.
