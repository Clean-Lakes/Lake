/*
 * Copyright 2026 CloudWeGo Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

type SSHSpec struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
}

type K8sSpec struct {
	Context   string `json:"context"`
	Namespace string `json:"namespace"`
}

type DatabaseSpec struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Name     string `json:"database,omitempty"`
	TLSMode  string `json:"tls_mode"`
}

type ResourceInput struct {
	LakeID string
	Name   string
	Env    string
	Tags   map[string]string
	SSH    SSHSpec
	K8s    K8sSpec
	DB     DatabaseSpec
}

type Resource struct {
	ID           string
	LakeID       string
	Kind         string
	Name         string
	SSH          SSHSpec
	K8s          K8sSpec
	DB           DatabaseSpec
	ExecuteAuthz bool
	Env          string
	Tags         map[string]string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

func (s *Store) CreateDatabase(ctx context.Context, kind string, in ResourceInput) (Resource, error) {
	return createDatabase(ctx, s.db, kind, in)
}

func createDatabase(ctx context.Context, db sqlWriter, kind string, in ResourceInput) (Resource, error) {
	if err := validName(in.Name); err != nil {
		return Resource{}, err
	}
	if in.LakeID == "" {
		return Resource{}, errors.New("lake ID is required")
	}
	switch kind {
	case "mysql":
		if in.DB.Port == 0 {
			in.DB.Port = 3306
		}
	case "postgres":
		if in.DB.Port == 0 {
			in.DB.Port = 5432
		}
		if in.DB.Name == "" {
			in.DB.Name = "postgres"
		}
	case "starrocks":
		if in.DB.Port == 0 {
			in.DB.Port = 9030
		}
	default:
		return Resource{}, errors.New("unsupported database kind")
	}
	if in.DB.Host == "" || in.DB.Host != strings.TrimSpace(in.DB.Host) || strings.ContainsAny(in.DB.Host, " \t\n\r/@\\\x00") {
		return Resource{}, errors.New("invalid database host")
	}
	if strings.Contains(in.DB.Host, ":") && net.ParseIP(in.DB.Host) == nil {
		return Resource{}, errors.New("database host with colons must be an IPv6 address")
	}
	if in.DB.Port < 1 || in.DB.Port > 65535 {
		return Resource{}, errors.New("database port must be between 1 and 65535")
	}
	if in.DB.Username == "" || in.DB.Username != strings.TrimSpace(in.DB.Username) || len(in.DB.Username) > 255 || strings.ContainsAny(in.DB.Username, "\n\r\x00") {
		return Resource{}, errors.New("invalid database username")
	}
	if len(in.DB.Name) > 255 || strings.ContainsAny(in.DB.Name, "\n\r\x00") {
		return Resource{}, errors.New("invalid database name")
	}
	if in.DB.TLSMode == "" {
		in.DB.TLSMode = "verify"
	}
	if in.DB.TLSMode != "verify" && in.DB.TLSMode != "disable" {
		return Resource{}, errors.New("TLS mode must be verify or disable")
	}
	if in.Tags == nil {
		in.Tags = map[string]string{}
	}
	id, err := newID()
	if err != nil {
		return Resource{}, err
	}
	spec, err := json.Marshal(struct {
		DB DatabaseSpec `json:"db"`
	}{in.DB})
	if err != nil {
		return Resource{}, err
	}
	tags, err := json.Marshal(in.Tags)
	if err != nil {
		return Resource{}, err
	}
	now := nowMillis()
	_, err = db.ExecContext(ctx, `INSERT INTO resource(id,lake_id,kind,name,spec,execute_authz,env,tags,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?,?)`, id, in.LakeID, kind, in.Name, string(spec), in.Env, string(tags), now, now)
	if err != nil {
		return Resource{}, fmt.Errorf("create %s resource %q: %w", kind, in.Name, err)
	}
	return Resource{ID: id, LakeID: in.LakeID, Kind: kind, Name: in.Name, DB: in.DB, Env: in.Env, Tags: in.Tags, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func (s *Store) CreateK8s(ctx context.Context, in ResourceInput) (Resource, error) {
	return createK8s(ctx, s.db, in)
}

func createK8s(ctx context.Context, db sqlWriter, in ResourceInput) (Resource, error) {
	if err := validName(in.Name); err != nil {
		return Resource{}, err
	}
	if in.LakeID == "" {
		return Resource{}, errors.New("lake ID is required")
	}
	if in.K8s.Context == "" || strings.TrimSpace(in.K8s.Context) != in.K8s.Context || strings.ContainsAny(in.K8s.Context, "\n\r\x00") {
		return Resource{}, errors.New("invalid Kubernetes context")
	}
	if in.K8s.Namespace == "" {
		in.K8s.Namespace = "default"
	}
	if in.K8s.Namespace != strings.TrimSpace(in.K8s.Namespace) || strings.ContainsAny(in.K8s.Namespace, " \t\n\r/\x00") {
		return Resource{}, errors.New("invalid Kubernetes namespace")
	}
	if in.Tags == nil {
		in.Tags = map[string]string{}
	}
	id, err := newID()
	if err != nil {
		return Resource{}, err
	}
	spec, err := json.Marshal(struct {
		K8s K8sSpec `json:"k8s"`
	}{in.K8s})
	if err != nil {
		return Resource{}, err
	}
	tags, err := json.Marshal(in.Tags)
	if err != nil {
		return Resource{}, err
	}
	now := nowMillis()
	_, err = db.ExecContext(ctx, `INSERT INTO resource(id,lake_id,kind,name,spec,execute_authz,env,tags,created_at,updated_at) VALUES (?,?,'k8s',?,?,0,?,?,?,?)`, id, in.LakeID, in.Name, string(spec), in.Env, string(tags), now, now)
	if err != nil {
		return Resource{}, fmt.Errorf("create Kubernetes resource %q: %w", in.Name, err)
	}
	return Resource{ID: id, LakeID: in.LakeID, Kind: "k8s", Name: in.Name, K8s: in.K8s, Env: in.Env, Tags: in.Tags, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func (s *Store) CreateHost(ctx context.Context, in ResourceInput) (Resource, error) {
	return createHost(ctx, s.db, in)
}

func createHost(ctx context.Context, db sqlWriter, in ResourceInput) (Resource, error) {
	if err := validName(in.Name); err != nil {
		return Resource{}, err
	}
	if in.LakeID == "" {
		return Resource{}, errors.New("lake ID is required")
	}
	if err := validateSSH(in.SSH); err != nil {
		return Resource{}, err
	}
	if in.Tags == nil {
		in.Tags = map[string]string{}
	}
	id, err := newID()
	if err != nil {
		return Resource{}, err
	}
	spec, err := json.Marshal(struct {
		SSH SSHSpec `json:"ssh"`
	}{SSH: in.SSH})
	if err != nil {
		return Resource{}, err
	}
	tags, err := json.Marshal(in.Tags)
	if err != nil {
		return Resource{}, err
	}
	now := nowMillis()
	_, err = db.ExecContext(ctx, `INSERT INTO resource(id, lake_id, kind, name, spec, execute_authz, env, tags, created_at, updated_at) VALUES (?, ?, 'host', ?, ?, 0, ?, ?, ?, ?)`, id, in.LakeID, in.Name, string(spec), in.Env, string(tags), now, now)
	if err != nil {
		return Resource{}, fmt.Errorf("create host %q: %w", in.Name, err)
	}
	return Resource{ID: id, LakeID: in.LakeID, Kind: "host", Name: in.Name, SSH: in.SSH, Env: in.Env, Tags: in.Tags, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func validateSSH(spec SSHSpec) error {
	if spec.Host == "" || spec.Host != strings.TrimSpace(spec.Host) || strings.ContainsAny(spec.Host, " \t\n\r/@") {
		return errors.New("invalid SSH host")
	}
	if strings.Contains(spec.Host, ":") && net.ParseIP(spec.Host) == nil {
		return errors.New("SSH host with colons must be an IPv6 address")
	}
	if spec.Port < 1 || spec.Port > 65535 {
		return errors.New("SSH port must be between 1 and 65535")
	}
	if spec.Username == "" || spec.Username != strings.TrimSpace(spec.Username) || strings.ContainsAny(spec.Username, " \t\n\r@/\\") {
		return errors.New("invalid SSH username")
	}
	return nil
}

func (s *Store) GetResource(ctx context.Context, id string) (Resource, error) {
	return scanResource(s.db.QueryRowContext(ctx, resourceSelect+` WHERE id = ?`, id))
}

func (s *Store) ListResources(ctx context.Context, lakeID string) ([]Resource, error) {
	rows, err := s.db.QueryContext(ctx, resourceSelect+` WHERE lake_id = ? ORDER BY name`, lakeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Resource
	for rows.Next() {
		resource, err := scanResource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, resource)
	}
	return out, rows.Err()
}

// ResolveResource accepts 湖/资源 or, when UseLake has been called, 资源.
// It resolves names to a stable ID but does not grant Agent authorization.
func (s *Store) ResolveResource(ctx context.Context, path string) (Resource, error) {
	var lake Lake
	var name string
	parts := strings.Split(path, "/")
	switch len(parts) {
	case 1:
		var err error
		lake, err = s.CurrentLake(ctx)
		if err != nil {
			return Resource{}, err
		}
		name = parts[0]
	case 2:
		var err error
		lake, err = s.GetLakeByName(ctx, parts[0])
		if err != nil {
			return Resource{}, err
		}
		name = parts[1]
	default:
		return Resource{}, fmt.Errorf("invalid resource path %q", path)
	}
	if err := validName(name); err != nil {
		return Resource{}, err
	}
	return scanResource(s.db.QueryRowContext(ctx, resourceSelect+` WHERE lake_id = ? AND name = ?`, lake.ID, name))
}

func (s *Store) SetExecuteAuthz(ctx context.Context, resourceID string, enabled bool) (Resource, error) {
	return setExecuteAuthz(ctx, s.db, resourceID, enabled)
}

func setExecuteAuthz(ctx context.Context, db sqlWriter, resourceID string, enabled bool) (Resource, error) {
	value := 0
	if enabled {
		value = 1
	}
	result, err := db.ExecContext(ctx, `UPDATE resource SET execute_authz = ?, updated_at = ? WHERE id = ?`, value, nowMillis(), resourceID)
	if err != nil {
		return Resource{}, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return Resource{}, err
	}
	if n == 0 {
		return Resource{}, ErrNotFound
	}
	return scanResource(db.QueryRowContext(ctx, resourceSelect+` WHERE id = ?`, resourceID))
}

const resourceSelect = `SELECT id, lake_id, kind, name, spec, execute_authz, env, tags, created_at, updated_at FROM resource`

func scanResource(row scanner) (Resource, error) {
	var resource Resource
	var specJSON, tagsJSON string
	var authz int
	var created, updated int64
	err := row.Scan(&resource.ID, &resource.LakeID, &resource.Kind, &resource.Name, &specJSON, &authz, &resource.Env, &tagsJSON, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Resource{}, ErrNotFound
	}
	if err != nil {
		return Resource{}, err
	}
	var spec struct {
		SSH SSHSpec      `json:"ssh"`
		K8s K8sSpec      `json:"k8s"`
		DB  DatabaseSpec `json:"db"`
	}
	if err := json.Unmarshal([]byte(specJSON), &spec); err != nil {
		return Resource{}, fmt.Errorf("decode resource spec: %w", err)
	}
	if err := json.Unmarshal([]byte(tagsJSON), &resource.Tags); err != nil {
		return Resource{}, fmt.Errorf("decode resource tags: %w", err)
	}
	resource.SSH = spec.SSH
	resource.K8s = spec.K8s
	resource.DB = spec.DB
	resource.ExecuteAuthz = authz == 1
	resource.CreatedAt, resource.UpdatedAt = fromMillis(created), fromMillis(updated)
	return resource, nil
}
