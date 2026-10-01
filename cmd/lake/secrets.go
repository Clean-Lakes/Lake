package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

// Migration is the only normal command that reads the old Keychain. Runtime
// chat and SSH operations always use the local FileVault.
func secretsCommand(ctx context.Context, args []string, root string, out, errOut io.Writer) error {
	if len(args) != 1 || args[0] != "migrate" {
		return errors.New("用法：lake secrets migrate")
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		return err
	}
	defer s.Close()
	return migrateSecrets(ctx, s, credential.Keychain{}, out, errOut)
}

type legacyVault interface {
	LoadModelAPIKey(string) ([]byte, error)
	DeleteModelAPIKey(string) error
	Load(string) ([]byte, error)
	Delete(string) error
}

func migrateSecrets(ctx context.Context, s *store.Store, legacy legacyVault, out, errOut io.Writer) error {
	vault := credential.FileVault{Root: s.Root()}
	config := lakeModelConfig{ModelProviders: make(map[string]providerConfig)}
	if err := readConfigFile(filepath.Join(s.Root(), "config.toml"), &config, false); err != nil {
		return err
	}
	providers := make([]string, 0, len(config.ModelProviders))
	for provider := range config.ModelProviders {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	migratedModels, migratedKeys := 0, 0
	for _, provider := range providers {
		exists, err := vault.HasModelAPIKey(provider)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		key, err := legacy.LoadModelAPIKey(provider)
		if err != nil {
			return fmt.Errorf("迁移模型 %s 的 API Key: %w；也可重新运行 lake model login --provider %s", provider, err, provider)
		}
		if err := vault.PutModelAPIKey(provider, key); err != nil {
			clearBytes(key)
			return err
		}
		clearBytes(key)
		if err := legacy.DeleteModelAPIKey(provider); err != nil {
			fmt.Fprintf(errOut, "警告：模型 %s 的旧钥匙串条目未删除：%v\n", provider, err)
		}
		migratedModels++
	}
	lakes, err := s.ListLakes(ctx)
	if err != nil {
		return err
	}
	for _, lake := range lakes {
		resources, err := s.ListResources(ctx, lake.ID)
		if err != nil {
			return err
		}
		for _, resource := range resources {
			attachments, err := s.ListAttachments(ctx, resource.ID)
			if err != nil {
				return err
			}
			for _, attachment := range attachments {
				if attachment.Kind != "credential" || !strings.HasPrefix(attachment.Ref, "keychain:") {
					continue
				}
				key, err := legacy.Load(attachment.Ref)
				if err != nil {
					return fmt.Errorf("迁移 %s/%s 的 SSH 私钥: %w；也可运行 lake res identity 重新导入", lake.Name, resource.Name, err)
				}
				newRef, err := vault.Import(key)
				clearBytes(key)
				if err != nil {
					return err
				}
				if _, err := s.SetCredentialRef(ctx, resource.ID, newRef); err != nil {
					_ = vault.Delete(newRef)
					return err
				}
				if err := legacy.Delete(attachment.Ref); err != nil {
					fmt.Fprintf(errOut, "警告：%s/%s 的旧钥匙串条目未删除：%v\n", lake.Name, resource.Name, err)
				}
				migratedKeys++
			}
		}
	}
	_, err = fmt.Fprintf(out, "迁移完成：模型 API Key %d 个，SSH 私钥 %d 个；新凭据保存在 %s\n", migratedModels, migratedKeys, filepath.Join(s.Root(), "secrets"))
	return err
}
