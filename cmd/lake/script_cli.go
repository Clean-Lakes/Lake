package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"golang.org/x/term"
)

func scriptCommand(ctx context.Context, s *store.Store, args []string, in io.Reader, out, errOut io.Writer) error {
	if len(args) > 0 {
		switch args[0] {
		case "start", "status", "wait", "cancel", "jobs":
			return scriptJobCommand(ctx, s, args, in, out, errOut)
		}
	}
	if len(args) == 0 {
		return errors.New("lake script 需要 add/list/read/run")
	}
	verb := args[0]
	args = args[1:]
	switch verb {
	case "add":
		if len(args) == 0 {
			return errors.New("script add 需要湖名或 湖/资源")
		}
		target := args[0]
		f := flags("lake script add", errOut)
		name := f.String("name", "", "脚本名称")
		path := f.String("file", "", "脚本文件")
		language := f.String("language", "sh", "sh 或 bash")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *name == "" || *path == "" {
			return errors.New("用法：lake script add <湖|湖/资源> --name 名称 --file 文件 [--language sh|bash]")
		}
		if *language != "sh" && *language != "bash" {
			return errors.New("脚本只支持 sh 或 bash")
		}
		body, err := os.ReadFile(*path)
		if err != nil {
			return err
		}
		defer clearBytes(body)
		if len(body) == 0 || len(body) > 1<<20 {
			return errors.New("脚本大小必须为 1–1024 KiB")
		}
		if scriptContainsSensitive(body) {
			return errors.New("脚本可能包含凭据内容，不允许导入")
		}
		input := store.ScriptInput{Name: *name, Language: *language, Content: body}
		lakeID := ""
		if strings.Contains(target, "/") {
			resource, err := s.ResolveResource(ctx, target)
			if err != nil {
				return err
			}
			lakeID = resource.LakeID
			input.ResourceID = resource.ID
		} else {
			lake, err := s.GetLakeByName(ctx, target)
			if err != nil {
				return err
			}
			lakeID = lake.ID
			input.LakeID = lake.ID
		}
		if err := authorizeDirectWorkflowAction(ctx, s, lakeID, "lake_script_add", target+"/"+*name, "cli", store.CommandSHA256(string(body))); err != nil {
			return err
		}
		item, err := s.SaveScript(ctx, input)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, item)
		}
		_, err = fmt.Fprintf(out, "已保存脚本 %s（%s），SHA-256 %s\n", item.Name, item.ID, item.SHA256)
		return err
	case "list":
		if len(args) == 0 {
			return errors.New("script list 需要湖名或 湖/资源")
		}
		target := args[0]
		f := flags("lake script list", errOut)
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("参数过多")
		}
		lakeID, resourceID := "", ""
		if strings.Contains(target, "/") {
			resource, err := s.ResolveResource(ctx, target)
			if err != nil {
				return err
			}
			resourceID = resource.ID
		} else {
			lake, err := s.GetLakeByName(ctx, target)
			if err != nil {
				return err
			}
			lakeID = lake.ID
		}
		items, err := s.ListScripts(ctx, lakeID, resourceID)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, items)
		}
		for _, item := range items {
			fmt.Fprintf(out, "%s\t%s\t%s\t%s\n", item.ID, item.Name, item.Language, item.SHA256)
		}
		return nil
	case "read", "run":
		if len(args) == 0 {
			return fmt.Errorf("script %s 需要脚本 ID", verb)
		}
		id := args[0]
		f := flags("lake script "+verb, errOut)
		resourceName := f.String("resource", "", "目标 湖/资源")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("参数过多")
		}
		if verb == "read" {
			script, content, err := s.ReadScript(ctx, id)
			if err != nil {
				return err
			}
			defer clearBytes(content)
			if scriptContainsSensitive(content) {
				return errors.New("脚本可能包含凭据内容，不允许输出")
			}
			if *asJSON {
				return writeJSON(out, map[string]any{"script": script, "content": string(content)})
			}
			_, err = out.Write(content)
			return err
		}
		script, err := s.GetScript(ctx, id)
		if err != nil {
			return err
		}
		if *resourceName == "" && script.ResourceID != "" {
			resource, err := s.GetResource(ctx, script.ResourceID)
			if err != nil {
				return err
			}
			lake, err := s.GetLake(ctx, resource.LakeID)
			if err != nil {
				return err
			}
			*resourceName = lake.Name + "/" + resource.Name
		}
		if *resourceName == "" {
			return errors.New("湖级脚本运行需要 --resource 湖/主机")
		}
		resource, err := s.ResolveResource(ctx, *resourceName)
		if err != nil {
			return err
		}
		lake, err := s.GetLake(ctx, resource.LakeID)
		if err != nil {
			return err
		}
		service, err := operate.NewServiceForLake(ctx, s, lake.Name)
		if err != nil {
			return err
		}
		defer service.CloseSessions()
		if file, ok := in.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
			scanner := bufio.NewScanner(in)
			service.Confirm = func(_ context.Context, path, summary string) (bool, error) {
				fmt.Fprintf(errOut, "SSH 脚本操作 %s：%s\n输入 yes 批准：", path, summary)
				if !scanner.Scan() {
					return false, scanner.Err()
				}
				return strings.TrimSpace(scanner.Text()) == "yes", nil
			}
		}
		result, err := executeStoredScript(ctx, s, service, id, resource.Name, script.SHA256)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, result)
		}
		_, err = fmt.Fprintf(out, "退出码 %d\n%s%s", result.ExitCode, result.Stdout, result.Stderr)
		return err
	default:
		return fmt.Errorf("未知脚本命令 %q", verb)
	}
}

func scriptContainsSensitive(content []byte) bool {
	upper := strings.ToUpper(string(content))
	for _, marker := range []string{"-----BEGIN ", "PRIVATE KEY", "API_KEY", "API-KEY", "SECRET_KEY", "ACCESS_TOKEN", "PASSWORD="} {
		if strings.Contains(upper, marker) {
			return true
		}
	}
	return false
}

func executeStoredScript(ctx context.Context, s *store.Store, service *operate.Service, scriptID, resourceName, expectedSHA string) (sshtransport.Result, error) {
	script, content, err := s.ReadScript(ctx, scriptID)
	if err != nil {
		return sshtransport.Result{}, err
	}
	defer clearBytes(content)
	if expectedSHA == "" || script.SHA256 != expectedSHA {
		return sshtransport.Result{}, errors.New("脚本版本与保存的工作流不一致")
	}
	resource, err := s.ResolveResource(ctx, service.Lake.Name+"/"+resourceName)
	if err != nil {
		return sshtransport.Result{}, err
	}
	if resource.Kind != "host" || resource.LakeID != service.Lake.ID {
		return sshtransport.Result{}, errors.New("脚本目标不是当前湖的 SSH 主机")
	}
	if script.LakeID != "" && script.LakeID != service.Lake.ID || script.ResourceID != "" && script.ResourceID != resource.ID {
		return sshtransport.Result{}, errors.New("脚本不属于目标湖或资源")
	}
	return service.RunScript(ctx, resourceName, script.ID, script.Language, script.SHA256, content)
}

type linkView struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type"`
}

func linkCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) < 2 || args[0] != "list" {
		return errors.New("用法：lake link list <湖/资源> [--json]")
	}
	resource, err := s.ResolveResource(ctx, args[1])
	if err != nil {
		return err
	}
	f := flags("lake link list", errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[2:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("参数过多")
	}
	links, err := s.ListLinks(ctx, resource.ID)
	if err != nil {
		return err
	}
	result := make([]linkView, 0, len(links))
	for _, link := range links {
		from, err := s.GetResource(ctx, link.FromID)
		if err != nil {
			return err
		}
		to, err := s.GetResource(ctx, link.ToID)
		if err != nil {
			return err
		}
		fromLake, err := s.GetLake(ctx, from.LakeID)
		if err != nil {
			return err
		}
		toLake, err := s.GetLake(ctx, to.LakeID)
		if err != nil {
			return err
		}
		result = append(result, linkView{From: fromLake.Name + "/" + from.Name, To: toLake.Name + "/" + to.Name, Type: link.Type})
	}
	if *asJSON {
		return writeJSON(out, result)
	}
	for _, item := range result {
		fmt.Fprintf(out, "%s\t%s\t%s\n", item.From, item.Type, item.To)
	}
	return nil
}
