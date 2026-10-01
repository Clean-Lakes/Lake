// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
INSERT INTO conversation_event(conversation_id,seq,kind,actor,payload,legacy_turn_id,created_at)
WITH ordered AS (
  SELECT id,conversation_id,prompt,answer,created_at,
    row_number() OVER(PARTITION BY conversation_id ORDER BY created_at,rowid) AS turn_number
  FROM conversation_turn
)
SELECT conversation_id,turn_number*2-1,'user','user',json_object('text',prompt),id,created_at FROM ordered
UNION ALL
SELECT conversation_id,turn_number*2,'assistant','assistant',json_object('text',answer),id,created_at FROM ordered;
`;
