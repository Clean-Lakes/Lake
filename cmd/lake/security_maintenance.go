package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
)

func runSecurityMaintenance(ctx context.Context, args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "recover-finalized-startup":
		flags := flag.NewFlagSet("security recover-finalized-startup", flag.ContinueOnError)
		home := flags.String("home", "", "existing finalized initial Lake Home")
		apply := flags.Bool("apply", false, "record explicit authorization and resume the verified foundation runtime; backend must be stopped")
		digest := flags.String("expected-digest", "", "exact digest returned by the reviewed preview")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *home == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --home is required")
		}
		report, err := ai.RecoverFinalizedInitialStartup(ctx, *home, *apply, *digest)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(report)
	case "finalize-migration":
		flags := flag.NewFlagSet("security finalize-migration", flag.ContinueOnError)
		home := flags.String("home", "", "existing offline Lake Home")
		apply := flags.Bool("apply", false, "publish verified completion and remove its canonical migration archive")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *home == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --home is required")
		}
		report, err := ai.FinalizeSecurityMigration(ctx, *home, *apply)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(report)
	case "recovery-live-review", "recovery-reconcile-preview", "recovery-reconcile":
		return runSecurityRecoveryLiveMaintenance(ctx, args)
	case "recovery-review", "recovery-work-history", "recovery-map", "recovery-confirm-policy", "recovery-confirm-legacy", "recovery-activate":
		flags := flag.NewFlagSet("security "+args[0], flag.ContinueOnError)
		home := flags.String("home", "", "existing offline recovery Home")
		input := flags.String("input", "", "private typed action JSON file")
		session := flags.String("session", "", "optional original session ID for work history")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *home == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --home is required")
		}
		var result any
		var err error
		switch args[0] {
		case "recovery-review":
			result, err = ai.SecurityRecoveryReviewOffline(ctx, *home)
		case "recovery-work-history":
			var owner *ai.SecurityHome
			owner, err = ai.OpenSecurityReadOnlyHome(*home, "")
			if err == nil {
				result, err = owner.SecurityRecoveryWorkHistory(ctx, *session, 1000)
				owner.Close()
			}
		case "recovery-map":
			var action ai.SecurityRecoveryMapping
			if err = readSecurityMaintenanceAction(*input, &action); err == nil {
				result, err = ai.MapSecurityRecoveryImpactOffline(ctx, *home, action)
			}
		case "recovery-confirm-policy":
			var action ai.SecurityRecoveryPolicyConfirmation
			if err = readSecurityMaintenanceAction(*input, &action); err == nil {
				result, err = ai.ConfirmSecurityRecoveryPolicyOffline(ctx, *home, action)
			}
		case "recovery-confirm-legacy":
			var action ai.SecurityRecoveryLegacyConfirmation
			if err = readSecurityMaintenanceAction(*input, &action); err == nil {
				result, err = ai.ConfirmSecurityRecoveryLegacyPolicyOffline(ctx, *home, action)
			}
		case "recovery-activate":
			var action ai.SecurityRecoveryAction
			if err = readSecurityMaintenanceAction(*input, &action); err == nil {
				result, err = ai.ActivateSecurityRecoveryOffline(ctx, *home, action)
			}
		}
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(result)
	case "checkpoint":
		flags := flag.NewFlagSet("security checkpoint", flag.ContinueOnError)
		home := flags.String("home", "", "existing offline Lake Home")
		output := flags.String("output", "", "new private checkpoint directory")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *home == "" || *output == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --home and --output are required")
		}
		checkpoint, err := ai.CreateSecurityCheckpoint(ctx, *home, *output)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(checkpoint)
	case "verify-backup":
		flags := flag.NewFlagSet("security verify-backup", flag.ContinueOnError)
		path := flags.String("path", "", "private paired checkpoint directory")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *path == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --path is required")
		}
		checkpoint, err := ai.VerifySecurityCheckpoint(ctx, *path)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(checkpoint)
	case "restore":
		flags := flag.NewFlagSet("security restore", flag.ContinueOnError)
		home := flags.String("home", "", "existing offline Lake Home")
		from := flags.String("from", "", "verified paired checkpoint directory")
		crossDevice := flags.Bool("import", false, "explicitly import with a new store identity")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *home == "" || *from == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --home and --from are required")
		}
		result, err := ai.RestoreSecurityBackup(ctx, *home, *from, *crossDevice)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(result)
	case "recovery-status":
		flags := flag.NewFlagSet("security recovery-status", flag.ContinueOnError)
		home := flags.String("home", "", "Lake Home with a pending restore")
		if err := flags.Parse(args[1:]); err != nil {
			return true, err
		}
		if *home == "" || flags.NArg() != 0 {
			return true, errors.New("an explicit --home is required")
		}
		result, err := ai.RecoveryPending(*home)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(result)
	case "enforce", "shadow", "mode":
		return runSecurityModeMaintenance(ctx, args)
	}
	return false, nil
}

func readSecurityMaintenanceAction(path string, action any) error {
	if path == "" {
		return errors.New("an explicit private --input JSON file is required")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !platform.Private(path, info) || info.Size() > 1<<20 {
		return errors.New("security: invalid private action file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(action); err != nil {
		return errors.New("security: invalid typed management action")
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return errors.New("security: trailing management action data")
	}
	return nil
}
