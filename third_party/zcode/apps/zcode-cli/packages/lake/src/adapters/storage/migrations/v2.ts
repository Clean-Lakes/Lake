// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE permission_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  silent_ssh_read INTEGER NOT NULL DEFAULT 1 CHECK (silent_ssh_read IN (0, 1)),
  silent_ssh_command INTEGER NOT NULL DEFAULT 0 CHECK (silent_ssh_command IN (0, 1))
);
INSERT INTO permission_policy(singleton, silent_ssh_read, silent_ssh_command) VALUES (1, 1, 0);
`;
