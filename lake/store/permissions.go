package store

import (
	"context"
	"errors"
)

// PermissionPolicy applies to every lake. A resource must still have its own
// execute authorization before any SSH operation can run.
type PermissionPolicy struct {
	SilentSSHRead    bool `json:"silent_ssh_read"`
	SilentSSHCommand bool `json:"silent_ssh_command"`
}

func (s *Store) GetPermissionPolicy(ctx context.Context) (PermissionPolicy, error) {
	return getPermissionPolicy(ctx, s.db)
}

func getPermissionPolicy(ctx context.Context, db sqlWriter) (PermissionPolicy, error) {
	var read, command int
	if err := db.QueryRowContext(ctx, `SELECT silent_ssh_read, silent_ssh_command FROM permission_policy WHERE singleton = 1`).Scan(&read, &command); err != nil {
		return PermissionPolicy{}, err
	}
	return PermissionPolicy{SilentSSHRead: read == 1, SilentSSHCommand: command == 1}, nil
}

func (s *Store) SetPermissionPolicy(ctx context.Context, key string, enabled bool) (PermissionPolicy, error) {
	return setPermissionPolicy(ctx, s.db, key, enabled)
}

func setPermissionPolicy(ctx context.Context, db sqlWriter, key string, enabled bool) (PermissionPolicy, error) {
	var statement string
	switch key {
	case "ssh-read":
		statement = `UPDATE permission_policy SET silent_ssh_read = ? WHERE singleton = 1`
	case "ssh-command":
		statement = `UPDATE permission_policy SET silent_ssh_command = ? WHERE singleton = 1`
	default:
		return PermissionPolicy{}, errors.New("未知的静默权限")
	}
	value := 0
	if enabled {
		value = 1
	}
	if _, err := db.ExecContext(ctx, statement, value); err != nil {
		return PermissionPolicy{}, err
	}
	return getPermissionPolicy(ctx, db)
}
