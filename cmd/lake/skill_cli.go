package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/extension/plugins"
	"github.com/cloudwego/eino/lake/extension/skills"
	"github.com/cloudwego/eino/lake/store"
)

func skillCommand(ctx context.Context, args []string, root string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("用法：lake skill list|show")
	}
	userRoot, err := settingsRoot(root)
	if err != nil {
		return err
	}
	s, err := store.Open(ctx, userRoot)
	if err != nil {
		return err
	}
	defer s.Close()
	manager := plugins.NewManager(s.Root(), s)
	mode := args[0]
	var name string
	flagArgs := args[1:]
	if mode == "show" {
		if len(flagArgs) == 0 {
			return errors.New("lake skill show 需要 Skill 名称")
		}
		name, flagArgs = flagArgs[0], flagArgs[1:]
	} else if mode != "list" {
		return errors.New("用法：lake skill list|show")
	}
	f := flags("lake skill "+mode, errOut)
	project := f.String("C", "", "代码项目目录")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(flagArgs); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake skill 参数过多")
	}
	projectRoot := ""
	if *project != "" {
		workspace, err := code.Open(*project)
		if err != nil {
			return err
		}
		projectRoot = workspace.Root
	}
	if mode == "show" {
		var skill skills.Skill
		if len(name) > 0 && !strings.Contains(name, "/") {
			skill, err = skills.Load(userRoot, projectRoot, name)
		}
		if strings.Contains(name, "/") || errors.Is(err, skills.ErrNotFound) {
			skill, err = manager.LoadSkill(ctx, name)
		}
		if err != nil {
			return err
		}
		if *asJSON {
			return json.NewEncoder(out).Encode(skill)
		}
		_, err = fmt.Fprintf(out, "%s [%s] — %s\n\n%s\n", skill.Name, skill.Scope, skill.Description, skill.Body)
		return err
	}
	list, err := skills.Discover(userRoot, projectRoot)
	if err != nil {
		return err
	}
	pluginSkills, err := manager.EnabledSkills(ctx)
	if err != nil {
		return err
	}
	list = append(list, pluginSkills...)
	if *asJSON {
		views := make([]map[string]string, 0, len(list))
		for _, skill := range list {
			views = append(views, map[string]string{"name": skill.Name, "scope": skill.Scope, "description": skill.Description, "sha256": skill.SHA256})
		}
		return json.NewEncoder(out).Encode(views)
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "NAME\tSCOPE\tDESCRIPTION"); err != nil {
		return err
	}
	for _, skill := range list {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\n", skill.Name, skill.Scope, skill.Description); err != nil {
			return err
		}
	}
	return w.Flush()
}
