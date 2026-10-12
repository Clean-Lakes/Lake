package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"github.com/Clean-Lakes/Lake/internal/legacykeychain"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
)

type migrationEntry struct {
	Kind     string `json:"kind"`
	LegacyID string `json:"legacyId"`
	NewID    string `json:"newCredentialId"`
}

func migrate(args []string) error {
	if len(args) == 0 || args[0] != "migrate" {
		return errors.New("use lake secrets migrate --manifest FILE")
	}
	flags := flag.NewFlagSet("secrets migrate", flag.ContinueOnError)
	file := flags.String("manifest", "", "explicit credential mapping")
	home := flags.String("home", lakeHome(), "Lake home")
	if e := flags.Parse(args[1:]); e != nil {
		return e
	}
	if runtime.GOOS != "darwin" || *file == "" {
		return errors.New("explicit migration requires a signed macOS binary and --manifest")
	}
	self, e := os.Executable()
	if e != nil {
		return e
	}
	if exec.Command("/usr/bin/codesign", "--verify", "--strict", self).Run() != nil {
		return errors.New("migration requires signed bin/lake from scripts/build_lake.sh")
	}
	b, e := os.ReadFile(*file)
	if e != nil {
		return errors.New("cannot read migration manifest")
	}
	var manifest struct {
		Version int              `json:"schemaVersion"`
		Entries []migrationEntry `json:"entries"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if dec.Decode(&manifest) != nil || manifest.Version != 1 || len(manifest.Entries) > 1000 {
		return errors.New("invalid migration manifest")
	}
	seen := map[string]bool{}
	for _, entry := range manifest.Entries {
		if (entry.Kind != "model" && entry.Kind != "ssh") || entry.LegacyID == "" || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$`).MatchString(entry.NewID) {
			return errors.New("invalid migration entry")
		}
		key := entry.Kind + "/" + entry.NewID
		if seen[key] {
			return errors.New("duplicate migration mapping")
		}
		seen[key] = true
	}
	vault := legacykeychain.Keychain{}
	return migrateEntries(*home, manifest.Entries, func(entry migrationEntry) ([]byte, error) {
		if entry.Kind == "model" {
			return vault.LoadModelAPIKey(entry.LegacyID)
		}
		return vault.Load(entry.LegacyID)
	})
}
func migrateEntries(home string, entries []migrationEntry, load func(migrationEntry) ([]byte, error)) error {
	for _, entry := range entries {
		secret, e := load(entry)
		if e != nil {
			return errors.New("legacy credential unavailable; no secret was logged")
		}
		e = func() error {
			defer func() {
				for i := range secret {
					secret[i] = 0
				}
			}()
			if len(secret) == 0 || len(secret) > 262144 {
				return errors.New("invalid legacy credential size")
			}
			kind := "models"
			if entry.Kind == "ssh" {
				kind = "ssh"
			}
			dir := filepath.Join(home, "secrets", kind)
			if e := os.MkdirAll(dir, 0700); e != nil {
				return e
			}
			os.Chmod(filepath.Join(home, "secrets"), 0700)
			os.Chmod(dir, 0700)
			path := filepath.Join(dir, entry.NewID)
			if old, e := os.ReadFile(path); e == nil {
				equal := bytes.Equal(old, secret)
				for i := range old {
					old[i] = 0
				}
				if equal {
					return nil
				}
				return errors.New("credential mapping already has a different value")
			}
			f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if e != nil {
				return errors.New("cannot write private credential")
			}
			defer f.Close()
			if _, e = f.Write(secret); e != nil {
				os.Remove(path)
				return errors.New("cannot write private credential")
			}
			return f.Sync()
		}()
		if e != nil {
			return e
		}
	}
	return printJSON([]byte(`{"migrated":true}`))
}
