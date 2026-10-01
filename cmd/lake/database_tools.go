package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/agent"
	agentpolicy "github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

type databaseInspectInput struct {
	Resource string `json:"resource" jsonschema:"description=已登记数据库资源名，跨湖时用 湖名/资源名"`
	Check    string `json:"check" jsonschema:"description=固定只读查询：version、databases 或 tables；不接受任意 SQL"`
}

type databaseInspectOutput struct {
	Resource  string     `json:"resource"`
	Check     string     `json:"check"`
	Columns   []string   `json:"columns"`
	Rows      [][]string `json:"rows"`
	Truncated bool       `json:"truncated"`
}

func newDatabaseInspectTool(s *store.Store, scope agent.RunScope) (tool.InvokableTool, error) {
	return utils.InferTool[databaseInspectInput, databaseInspectOutput]("lake_database_inspect",
		"对已登记的 MySQL、PostgreSQL 或 StarRocks 资源执行固定只读元数据查询：version、databases、tables。不接受任意 SQL；资源须开启执行授权。",
		func(ctx context.Context, in databaseInspectInput) (databaseInspectOutput, error) {
			return runDatabaseInspect(ctx, s, in, scope)
		})
}

func databaseInspectionSQL(kind, check string) (string, error) {
	switch check {
	case "version":
		return "SELECT VERSION()", nil
	case "databases":
		if kind == "postgres" {
			return "SELECT datname FROM pg_database WHERE datallowconn = true ORDER BY datname LIMIT 201", nil
		}
		return "SHOW DATABASES", nil
	case "tables":
		if kind == "postgres" {
			return "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name LIMIT 201", nil
		}
		return "SHOW TABLES", nil
	default:
		return "", errors.New("只支持 version、databases、tables 固定检查，不接受任意 SQL")
	}
}

func openInspectionDB(spec store.DatabaseSpec, kind string, password []byte) (*sql.DB, error) {
	address := net.JoinHostPort(spec.Host, strconv.Itoa(spec.Port))
	if kind == "mysql" || kind == "starrocks" {
		cfg := mysqldriver.NewConfig()
		cfg.Net = "tcp"
		cfg.Addr = address
		cfg.User = spec.Username
		cfg.Passwd = string(password)
		cfg.DBName = spec.Name
		cfg.Timeout = 5 * time.Second
		cfg.ReadTimeout = 10 * time.Second
		cfg.WriteTimeout = 10 * time.Second
		if spec.TLSMode == "verify" {
			cfg.TLSConfig = "true"
		} else {
			cfg.TLSConfig = "false"
		}
		connector, err := mysqldriver.NewConnector(cfg)
		if err != nil {
			return nil, err
		}
		return sql.OpenDB(connector), nil
	}
	if kind == "postgres" {
		uri := url.URL{Scheme: "postgres", Host: address, Path: "/" + spec.Name, User: url.UserPassword(spec.Username, string(password))}
		params := url.Values{"connect_timeout": {"5"}, "application_name": {"lake"}}
		if spec.TLSMode == "verify" {
			params.Set("sslmode", "verify-full")
		} else {
			params.Set("sslmode", "disable")
		}
		uri.RawQuery = params.Encode()
		cfg, err := pgx.ParseConfig(uri.String())
		if err != nil {
			return nil, err
		}
		return stdlib.OpenDB(*cfg), nil
	}
	return nil, errors.New("该资源不是支持的数据库类型")
}

func runDatabaseInspect(ctx context.Context, s *store.Store, in databaseInspectInput, scopes ...agent.RunScope) (databaseInspectOutput, error) {
	if in.Resource == "" {
		return databaseInspectOutput{}, errors.New("需要数据库资源名")
	}
	resource, err := s.ResolveResource(ctx, strings.TrimPrefix(in.Resource, "@"))
	if err != nil {
		return databaseInspectOutput{}, err
	}
	if resource.Kind != "mysql" && resource.Kind != "postgres" && resource.Kind != "starrocks" {
		return databaseInspectOutput{}, errors.New("该资源不是数据库")
	}
	query, err := databaseInspectionSQL(resource.Kind, in.Check)
	if err != nil {
		return databaseInspectOutput{}, err
	}
	if in.Check == "tables" && resource.Kind != "postgres" && resource.DB.Name == "" {
		return databaseInspectOutput{}, errors.New("查询表时需要先为该数据库资源配置数据库名")
	}
	lake, err := s.GetLake(ctx, resource.LakeID)
	if err != nil {
		return databaseInspectOutput{}, err
	}
	path := lake.Name + "/" + resource.Name
	actionID, err := store.NewActionID()
	if err != nil {
		return databaseInspectOutput{}, err
	}
	journal := func(event, detail string) {
		logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.AppendJournal(logCtx, store.JournalInput{ActionID: actionID, Actor: "agent", TargetPath: path, Tool: "lake_database_inspect", Risk: "read", Event: event, Detail: detail})
	}
	journal("requested", "check="+in.Check)
	if len(scopes) != 0 {
		frozen := false
		for _, id := range scopes[0].ResourceIDs {
			if id == resource.ID {
				frozen = true
				break
			}
		}
		err := agentpolicy.Authorize(ctx, agentpolicy.Input{
			Spec: agent.ToolSpec{Name: "lake_database_inspect", Capability: "read"}, Scope: scopes[0], Origin: "model",
			ResourceID: resource.ID, ResourceFrozen: frozen, ResourceAuthorized: resource.ExecuteAuthz,
		}, nil)
		if err != nil {
			journal("denied", "policy_scope_or_authorization")
			return databaseInspectOutput{}, err
		}
	}
	if !resource.ExecuteAuthz {
		journal("denied", "execute_authz=false")
		return databaseInspectOutput{}, fmt.Errorf("资源 %s 尚未开启执行授权", path)
	}
	attachments, err := s.ListAttachments(ctx, resource.ID)
	if err != nil {
		journal("failed", "credential_lookup")
		return databaseInspectOutput{}, err
	}
	var password []byte
	for _, item := range attachments {
		if item.Kind == "credential" {
			password, err = (credential.FileVault{Root: s.Root()}).LoadDatabasePassword(item.Ref)
			if err != nil {
				journal("failed", "credential_load")
				return databaseInspectOutput{}, errors.New("读取数据库凭据失败")
			}
			break
		}
	}
	defer clearBytes(password)
	db, err := openInspectionDB(resource.DB, resource.Kind, password)
	if err != nil {
		journal("failed", "driver_config")
		return databaseInspectOutput{}, errors.New("数据库连接配置无效")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(0)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	journal("started", "check="+in.Check)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		journal("failed", "query_failed")
		return databaseInspectOutput{}, redactedDatabaseError(err, password)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		journal("failed", "columns_failed")
		return databaseInspectOutput{}, err
	}
	result := databaseInspectOutput{Resource: path, Check: in.Check, Columns: columns, Rows: make([][]string, 0)}
	for rows.Next() {
		if len(result.Rows) >= 200 {
			result.Truncated = true
			break
		}
		values := make([]sql.RawBytes, len(columns))
		dest := make([]any, len(columns))
		for i := range values {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			journal("failed", "scan_failed")
			return databaseInspectOutput{}, redactedDatabaseError(err, password)
		}
		row := make([]string, len(columns))
		for i, v := range values {
			if len(v) > 512 {
				v = v[:512]
			}
			row[i] = string(v)
		}
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		journal("failed", "rows_failed")
		return databaseInspectOutput{}, redactedDatabaseError(err, password)
	}
	journal("completed", fmt.Sprintf("check=%s rows=%d truncated=%t", in.Check, len(result.Rows), result.Truncated))
	return result, nil
}

func redactedDatabaseError(err error, password []byte) error {
	message := err.Error()
	if len(password) > 0 {
		message = strings.ReplaceAll(message, string(password), "[REDACTED]")
		message = strings.ReplaceAll(message, url.QueryEscape(string(password)), "[REDACTED]")
	}
	if len(message) > 512 {
		message = message[:512]
	}
	return fmt.Errorf("数据库连接或查询失败: %s", message)
}
