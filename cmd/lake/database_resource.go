package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

func normalizeDatabaseKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "mysql":
		return "mysql"
	case "pg", "postgres", "postgresql":
		return "postgres"
	case "starrocks", "starrock", "starsrock":
		return "starrocks"
	default:
		return ""
	}
}

func addDatabaseResource(ctx context.Context, s *store.Store, args []string, input io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake res add-db 需要资源名")
	}
	path := args[0]
	f := flags("lake res add-db", errOut)
	kind := f.String("kind", "", "mysql、postgres 或 starrocks")
	host := f.String("host", "", "数据库主机")
	port := f.Int("port", 0, "端口；默认 MySQL 3306、PostgreSQL 5432、StarRocks 9030")
	user := f.String("user", "", "数据库用户名")
	dbName := f.String("database", "", "数据库名；PostgreSQL 默认 postgres")
	tlsMode := f.String("tls", "verify", "verify 或 disable")
	passwordStdin := f.Bool("password-stdin", false, "从标准输入读取密码，不在命令行传密钥")
	env := f.String("env", "", "环境")
	var tags tagFlags
	f.Var(&tags, "tag", "键=值，可重复")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake res add-db 参数过多")
	}
	normalized := normalizeDatabaseKind(*kind)
	if normalized == "" || *host == "" || *user == "" {
		return errors.New("用法：lake res add-db <湖/资源名> --kind mysql|postgres|starrocks --host 主机 --user 用户 [--port 端口] [--database 名称] [--tls verify|disable] [--password-stdin]")
	}
	var password []byte
	if *passwordStdin {
		var err error
		password, err = io.ReadAll(io.LimitReader(input, 65537))
		if err != nil {
			return fmt.Errorf("读取数据库密码: %w", err)
		}
		if len(password) > 65536 {
			clearBytes(password)
			return errors.New("数据库密码超过 64 KB")
		}
		defer clearBytes(password)
	}
	lake, name, err := resourceParent(ctx, s, path)
	if err != nil {
		return err
	}
	vault := credential.FileVault{Root: s.Root()}
	ref := ""
	if len(password) > 0 {
		ref, err = vault.ImportDatabasePassword(password)
		if err != nil {
			return err
		}
	}
	actionID, err := store.NewActionID()
	if err != nil {
		if ref != "" {
			_ = vault.DeleteDatabasePassword(ref)
		}
		return err
	}
	var resource store.Resource
	err = s.Mutate(ctx, func(m *store.Mutation) error {
		resource, err = m.CreateDatabase(ctx, normalized, store.ResourceInput{LakeID: lake.ID, Name: name, Env: *env, Tags: tags, DB: store.DatabaseSpec{Host: *host, Port: *port, Username: *user, Name: *dbName, TLSMode: *tlsMode}})
		if err != nil {
			return err
		}
		if ref != "" {
			if _, err = m.SetCredentialRef(ctx, resource.ID, ref); err != nil {
				return err
			}
		}
		_, err = m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: lake.Name + "/" + name, Tool: "lake.res.add-db", Risk: "none", Event: "completed", Detail: "resource_id=" + resource.ID})
		return err
	})
	if err != nil {
		if ref != "" {
			_ = vault.DeleteDatabasePassword(ref)
		}
		return err
	}
	if *asJSON {
		return writeJSON(out, resourceView(lake.Name, resource))
	}
	_, err = fmt.Fprintf(out, "已存入 %s 数据库资源 %s/%s\n", normalized, lake.Name, name)
	return err
}
