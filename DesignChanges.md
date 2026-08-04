# Design changes vs maquette

- 2026-08-01 — Validation queue, "Recently resolved" section: rows are now expandable (chevron + click) to reveal the full SQL statement and the full execution error, mirroring the audit log expandable rows. The mockup showed single truncated lines only.
- 2026-08-01 — Validation queue, expanded failed insert: added an "Edit and retry this insert" button that reopens the table tab with the row re-staged for editing. Not in the mockup.
- 2026-08-01 — DataGrid, staged insert row: cells left to their database default now display the default expression (e.g. `CURRENT_TIMESTAMP`) in muted text instead of a copied value, signalling the column is omitted from the generated INSERT.
