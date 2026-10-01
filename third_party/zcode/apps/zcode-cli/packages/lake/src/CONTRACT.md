# Lake runtime

`dispatch` is the sole operations command boundary. `subscribe` publishes only redacted events after persistence. `close` cancels and releases runtime-owned work. Commands never obtain credentials in returned values. Desktop adapters forward input without owning proposals, approval policy, terminals or SQLite state.

Existing schema-19 data and frontend protocol remain readable. Approval is scoped to the admitted identity and execution ID, and revoked authorization wins over approval. Dispatched unknown results cannot be replayed automatically. See `.agents/specs/lake-typescript.md` for migration and event ordering.
