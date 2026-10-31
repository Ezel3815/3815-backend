# MCQ backend

NestJS + Prisma (MySQL). Content is managed by admins through the dashboard and
only **read** by students. Code: `src/mcq/`, `src/controllers/mcq*.controller.ts`.

## Deploy
1. `prisma/schema.prisma` gained 3 models (`McqSubject`, `McqCollection`, `McqQuestion`).
2. Your Dockerfile runs `prisma db push`, so the tables are created on the next deploy.
   (If you use `prisma migrate deploy` instead, the SQL is in
   `prisma/migrations/20261030000000_add_mcq/migration.sql`.)
3. Locally: `npx prisma generate` once so the new models exist in the client.
4. Nothing else to configure; no new dependencies.

> Heads-up (not touched): `20261021000000_add_ai_scan` and
> `20261021000100_add_quiz_and_payments` contain a **folder** named `migration.sql`
> instead of a file, which `prisma migrate deploy` cannot read. `db push` is
> unaffected.

## Student API (any signed-in, active user)
| Method | Path | Notes |
|---|---|---|
| GET | `/mcq/catalog` | `{ subjects, collections, questions }`, published content only. Sends `ETag`; answers `304` when `If-None-Match` matches. |

`questions[]` item: `id, subject_id, collection_id, text, options[{id,text}], correct[ids], explanation|null, key_points[], exam_label|null, source|null`.
Questions are ordered by collection, then `order`. Unpublished questions, collections or
subjects (and anything under an unpublished parent) are never returned.
The answer key is part of the payload: the app grades locally. Exam mode hides it in the
UI only; if you later need answers to be un-sniffable during an exam, grading must move
server-side.

## Admin API (admin role, `DRole`)
Base: `/admin/mcq`

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/subjects` | list (with counts) / create |
| PUT/DELETE | `/subjects/:id` | update / delete (`?force=true` also deletes its collections+questions; otherwise 409 if not empty) |
| GET/POST | `/collections` (`?subject_id=`) | list / create |
| PUT/DELETE | `/collections/:id` | update (changing `subject_id` moves its questions too) / delete (`?force=true`) |
| GET | `/questions` | `?subject_id=&collection_id=&search=&published=&page=&limit=` (limit max 200) -> `{items,total,page,limit}` |
| GET/POST | `/questions`, `/questions/:id` | read / create |
| PUT/DELETE | `/questions/:id` | update (partial) / delete |
| POST | `/import` | bulk import, see below |
| GET | `/export` (`?subject_id=`) | everything incl. unpublished, in the import format |

Create bodies use the same field names as the import file. `id` is optional on create
(a UUID is generated); allowed ids are lowercase `[a-z0-9._-]`, max 64 chars (MySQL
collation is case-insensitive). New items without `order` are appended.

### Validation (same rules as the app)
text/name/title not empty; 2-12 options with unique ids and non-empty text; `correct` lists
1+ option ids that all exist (1 id = single answer, 2+ = multiple answer, graded all-or-nothing);
`explanation`, `key_points`, `exam_label`, `source` optional. A question's subject is taken
from its collection. When updating, `options` and `correct` must be sent together.

### Bulk import: `POST /admin/mcq/import`
Body = `{ "subjects": [...], "collections": [...], "questions": [...] }`
(see `examples/sample-import.json`; every record needs an `id`; max 5000 records per request).

- Upserts by `id`: **re-running the same file changes nothing**; changed fields are updated,
  `order` and `published` are kept unless you send them.
- `?dry_run=true`: validate and report only.
- `?strict=true`: write nothing if any record is invalid.
- Invalid records are never silently dropped: the response lists each one:
  ```json
  { "applied": true, "created": {"subjects":1,"collections":1,"questions":3},
    "updated": {"subjects":0,"collections":0,"questions":0},
    "skipped": 1,
    "issues": [{ "kind":"question", "id":"q9", "message":"correct refers to unknown option id(s): z" }] }
  ```
- Writes are chunked (100 per transaction); after a crash just run the import again.

Examples:
```bash
curl -X POST "$API/admin/mcq/import?dry_run=true" -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" --data @src/mcq/examples/sample-import.json
curl -X POST "$API/admin/mcq/questions" -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"collection_id":"gs-liver-intro","text":"...","options":[{"id":"a","text":"..."},{"id":"b","text":"..."}],"correct":["b"]}'
```

## Not included (by design, for now)
Student progress (attempts, bookmarks, sessions) is still stored on the phone; syncing it
to the server (and per-question statistics for you) is a separate step.
The catalog is served as one response (cached 60 s per server instance); if a bank grows to
tens of thousands of questions, switch the app to per-collection loading.

## Tests
`src/mcq/mcq.validation.spec.ts`, `src/mcq/mcq.service.spec.ts` (in-memory Prisma fake).
`npm test`.
