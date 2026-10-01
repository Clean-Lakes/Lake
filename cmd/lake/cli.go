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

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

type credentialStore interface {
	Import([]byte) (string, error)
	Delete(string) error
}

// Tests may replace keyVault; normal runs resolve the vault from the store.
var keyVault credentialStore

func resourceVault(s *store.Store) credentialStore {
	if keyVault != nil {
		return keyVault
	}
	return credential.FileVault{Root: s.Root()}
}

const usage = `Lake — SRE 运维 Agent

用法:
  lake [-m 模型] [-c key=value] [-p 配置档] [-C 代码项目目录] [提问]   # 进入 Lake Agent 对话
  lake model configure --model 名称 --base-url URL [--provider mimo] [--wire-api anthropic|openai_chat|openai_responses]
  lake model login [--provider mimo]
  lake model add --provider 名称 --model 名称 [--base-url URL] [--wire-api anthropic|openai_chat|openai_responses]
  lake model ls [--json]
  lake model use <模型名>
  lake settings                         # 桌面设置 JSON 接口（从 stdin 读取）
  lake mcp login --name 服务名 (--env 变量名 | --header 请求头名)
  lake ops-mcp --lake 湖名 [--require-approval=false] # 绑定湖的运维 MCP；默认逐次审批
  lake secrets migrate                   # 一次性迁移旧钥匙串凭据
  lake add <湖名> [--desc 描述] [--json]
  lake ls [--json]
  lake current [--json]
  lake use <湖名> [--json]
  lake res add <资源名|湖/资源名> --ssh 用户@主机[:端口] [--identity 私钥绝对路径] [--env 环境] [--tag 键=值] [--json]
  lake res add-k8s <资源名|湖/资源名> --kubeconfig 绝对路径 [--context 名称] [--namespace 名称] [--json]
  lake res add-db <资源名|湖/资源名> --kind mysql|postgres|starrocks --host 主机 --user 用户 [--port 端口] [--database 名称] [--tls verify|disable] [--password-stdin] [--json]
  lake res k8s-contexts --kubeconfig 绝对路径
  lake res identity <资源名|湖/资源名> --file 私钥绝对路径
  lake res ls [--lake 湖名 | --all] [--json]
  lake res authz <资源名|湖/资源名> on|off [--json]
  lake res authz --all on|off [--lake 湖名] [--json]
  lake permissions [--json]
  lake permissions set ssh-read|ssh-command on|off [--json]
  lake conversation list [--json]
  lake conversation archived [--json]
  lake conversation create <湖名> [--json]
  lake conversation show <会话ID> [--json]
  lake conversation rename <会话ID> <标题> [--json]
  lake conversation archive <会话ID> [--json]
  lake conversation restore <会话ID> [--json]
  lake memory show|on|off [--json]
  lake memory edit <记忆ID> <内容> [--json]
  lake memory delete <记忆ID> [--json]
  lake skill list [-C 代码项目目录] [--json]
  lake skill show <名称> [-C 代码项目目录] [--json]
  lake plugin inspect <本地目录>
  lake plugin list [--json]
  lake plugin install <本地目录> --sha256 <校验值>
  lake plugin enable|disable <名称>
  lake hook status|enable|disable -C <项目目录>
  lake code add <湖名> <项目名> --path <本地目录> [--json]
  lake code list [--json]
  lake code bind <会话ID> <项目ID|none> [--json]
  lake code remote add <湖名> <名称> --resource 湖/主机 --root /规范绝对路径
  lake code remote list [--lake 湖名]
  lake code remote authz <工作区ID> on|off
  lake code remote bind <会话ID> <工作区ID|none>
  lake code remote files|read|run|write <工作区ID> [参数]
  lake workflow add <湖名> --file 定义.json [--json]
  lake workflow update <工作流ID> --file 定义.json [--json]
  lake workflow validate --file 定义-v2.json|yaml [--json]
  lake workflow dry-run [湖名] --file 定义-v2.json|yaml [--json]
  lake workflow save <湖名> --file 定义-v2.json|yaml [--json]
  lake workflow amend <v2工作流ID> --file 定义-v2.json|yaml [--json]
  lake specialist configure < 配置请求.json
  lake specialist list|tasks
  lake specialist status <任务ID>
  lake specialist run <专员名> --request-file 任务.txt [--lake 湖名] [--project 项目ID]
  lake specialist resume <任务ID> [--lake 湖名] [--project 项目ID] [--retry-writes]
  lake workflow manage < 结构化管理请求.json
  lake workflow list [--lake 湖名] [--json]
  lake workflow show <工作流ID> [--json]
  lake workflow run <工作流ID> [--resource 单选目标 | --target 多选目标 ... | --bind 原资源名=目标资源名 ...] [--json]
  lake workflow runs [--lake 湖名] [--json]
  lake workflow status <运行ID> [--json]
  lake workflow events <运行ID> [--json]
  lake workflow resume <运行ID> [--retry-writes] [--json]
  lake workflow run|resume <v2 ID> [--project 已登记项目ID] [--retry-writes] [--json]
  lake workflow recover <运行ID> --force [--json]  # 原进程已退出时标记中断
  lake workflow enable|disable <工作流ID> [--json]
  lake schedule add <v2工作流ID> (--at RFC3339 | --cron 五字段表达式) [--tz 时区]
  lake schedule list [--lake 湖名] [--json]
  lake schedule status|runs|stop <计划ID> [--json]
  lake schedule authorize <计划ID> --node SSH写节点ID --resource 资源名 --command-sha256 摘要 --expires RFC3339 [--max-runs 次数]
  lake schedule serve|install|uninstall
  lake script add <湖|湖/资源> --name 名称 --file 文件 [--language sh|bash]

  lake script start <脚本ID> [--resource 湖/资源] [--timeout 秒]
  lake script status|wait|cancel <任务ID> [--seconds 1–60] [--json]
  lake script jobs <湖名> --json
  lake script list <湖|湖/资源> [--json]
  lake script read <脚本ID> [--json]
  lake script run <脚本ID> [--resource 湖/主机] [--json]
  lake link list <湖/资源> [--json]
  lake web serve [--listen 127.0.0.1:8765] [--token-file 私有文件] [--origin HTTPS来源] [--tls-cert 证书 --tls-key 私钥]
  lake web token-create [--file ~/.lake/web.token]
  lake tui                                # 同一会话 API 的只读文字终端
  lake journal --tail [--limit 条数] [--json]
  lake bridge                            # 桌面客户端 JSON Lines 接口

设置 LAKE_HOME 可指定数据目录；默认 ~/.lake。
`

func run(ctx context.Context, args []string, root string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return runChat(ctx, nil, root, os.Stdin, stdout, stderr)
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		_, err := io.WriteString(stdout, usage)
		return err
	}
	if args[0] == "model" {
		return modelCommand(args[1:], root, os.Stdin, stdout, stderr)
	}
	if args[0] == "settings" {
		if len(args) != 1 {
			return errors.New("用法：lake settings")
		}
		return settingsCommand(root, os.Stdin, stdout)
	}
	if args[0] == "mcp" {
		return mcpCredentialCommand(args[1:], root, os.Stdin, stdout, stderr)
	}
	if args[0] == "skill" {
		return skillCommand(ctx, args[1:], root, stdout, stderr)
	}
	if args[0] == "secrets" {
		return secretsCommand(ctx, args[1:], root, stdout, stderr)
	}
	if args[0] == "bridge" {
		if len(args) == 1 {
			return runBridge(ctx, root, os.Stdin, stdout)
		}
		if len(args) == 3 && args[1] == "--conversation" && args[2] != "" {
			return runBridgeConversation(ctx, root, args[2], os.Stdin, stdout)
		}
		return errors.New("lake bridge 仅支持 --conversation <会话ID>")
	}
	if strings.HasPrefix(args[0], "-") {
		return runChat(ctx, args, root, os.Stdin, stdout, stderr)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		return err
	}
	defer s.Close()
	switch args[0] {
	case "add":
		return addLake(ctx, s, args[1:], stdout, stderr)
	case "ls":
		return listLakes(ctx, s, args[1:], stdout, stderr)
	case "current":
		return currentLake(ctx, s, args[1:], stdout, stderr)
	case "use":
		return useLake(ctx, s, args[1:], stdout, stderr)
	case "res":
		return resourceCommand(ctx, s, args[1:], stdout, stderr)
	case "permissions":
		return permissionsCommand(ctx, s, args[1:], stdout, stderr)
	case "ops-mcp":
		return opsMCPCommand(ctx, s, args[1:], stderr)
	case "conversation":
		return conversationCommand(ctx, s, args[1:], stdout, stderr)
	case "memory":
		return memoryCommand(ctx, s, args[1:], stdout)
	case "code":
		return codeProjectCommand(ctx, s, args[1:], os.Stdin, stdout, stderr)
	case "workflow":
		return workflowCommand(ctx, s, args[1:], os.Stdin, stdout, stderr)
	case "schedule":
		return scheduleCommand(ctx, s, args[1:], stdout, stderr)
	case "script":
		return scriptCommand(ctx, s, args[1:], os.Stdin, stdout, stderr)
	case "link":
		return linkCommand(ctx, s, args[1:], stdout, stderr)
	case "web":
		return webCommand(ctx, s, args[1:], stdout, stderr)
	case "tui":
		return tuiCommand(ctx, s, args[1:], stdout)
	case "specialist":
		return specialistCommand(ctx, s, args[1:], os.Stdin, stdout, stderr)
	case "plugin":
		return pluginCommand(ctx, s, args[1:], stdout, stderr)
	case "hook":
		return hookCommand(ctx, s, args[1:], stdout, stderr)
	case "journal":
		return listJournal(ctx, s, args[1:], stdout, stderr)
	default:
		return runChat(ctx, args, root, os.Stdin, stdout, stderr)
	}
}

func flags(name string, stderr io.Writer) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(stderr)
	return set
}

func addLake(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake add 需要湖名")
	}
	name := args[0]
	f := flags("lake add", errOut)
	description := f.String("desc", "", "描述")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake add 参数过多")
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return err
	}
	var lake store.Lake
	if err := s.Mutate(ctx, func(m *store.Mutation) error {
		var err error
		lake, err = m.CreateLake(ctx, name, *description)
		if err != nil {
			return err
		}
		_, err = m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: name, Tool: "lake.add", Risk: "none", Event: "completed", Detail: "lake_id=" + lake.ID})
		return err
	}); err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, lakeView(lake))
	}
	_, err = fmt.Fprintf(out, "已创建湖 %s (%s)\n", lake.Name, lake.ID)
	return err
}

func listLakes(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	f := flags("lake ls", errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake ls 参数过多")
	}
	lakes, err := s.ListLakes(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		views := make([]any, 0, len(lakes))
		for _, lake := range lakes {
			views = append(views, lakeView(lake))
		}
		return writeJSON(out, views)
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "NAME\tDESCRIPTION"); err != nil {
		return err
	}
	for _, lake := range lakes {
		if _, err := fmt.Fprintf(w, "%s\t%s\n", lake.Name, lake.Description); err != nil {
			return err
		}
	}
	return w.Flush()
}

func currentLake(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	f := flags("lake current", errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake current 参数过多")
	}
	lake, err := s.CurrentLake(ctx)
	if errors.Is(err, store.ErrNoCurrentLake) {
		if *asJSON {
			return writeJSON(out, nil)
		}
		_, err = io.WriteString(out, "当前未选择湖\n")
		return err
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, lakeView(lake))
	}
	_, err = fmt.Fprintf(out, "当前湖：%s\n", lake.Name)
	return err
}

func useLake(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake use 需要湖名")
	}
	name := args[0]
	f := flags("lake use", errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake use 参数过多")
	}
	lake, err := s.GetLakeByName(ctx, name)
	if err != nil {
		return err
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return err
	}
	if err := s.Mutate(ctx, func(m *store.Mutation) error {
		if err := m.UseLake(ctx, lake.ID); err != nil {
			return err
		}
		_, err := m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: lake.Name, Tool: "lake.use", Risk: "none", Event: "completed", Detail: "lake_id=" + lake.ID})
		return err
	}); err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, lakeView(lake))
	}
	_, err = fmt.Fprintf(out, "当前湖：%s\n", lake.Name)
	return err
}

func resourceCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake res 需要 add、ls 或 authz 子命令")
	}
	switch args[0] {
	case "add":
		return addResource(ctx, s, args[1:], out, errOut)
	case "add-k8s":
		return addK8sResource(ctx, s, args[1:], out, errOut)
	case "add-db":
		return addDatabaseResource(ctx, s, args[1:], os.Stdin, out, errOut)
	case "k8s-contexts":
		return listKubeContexts(ctx, args[1:], out, errOut)
	case "identity":
		return setResourceIdentity(ctx, s, args[1:], out, errOut)
	case "ls":
		return listResources(ctx, s, args[1:], out, errOut)
	case "authz":
		return authorizeResource(ctx, s, args[1:], out, errOut)
	default:
		return fmt.Errorf("未知资源命令 %q", args[0])
	}
}

func setResourceIdentity(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("用法：lake res identity <资源> --file 私钥绝对路径")
	}
	path := args[0]
	f := flags("lake res identity", errOut)
	file := f.String("file", "", "私钥绝对路径")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 || *file == "" {
		return errors.New("用法：lake res identity <资源> --file 私钥绝对路径")
	}
	resource, err := s.ResolveResource(ctx, path)
	if err != nil {
		return err
	}
	if resource.Kind != "host" {
		return errors.New("lake res identity 仅适用于 SSH 主机")
	}
	lake, err := s.GetLake(ctx, resource.LakeID)
	if err != nil {
		return err
	}
	attachments, err := s.ListAttachments(ctx, resource.ID)
	if err != nil {
		return err
	}
	var oldRef string
	for _, attachment := range attachments {
		if attachment.Kind == "credential" {
			oldRef = attachment.Ref
			break
		}
	}
	privateKey, err := readIdentityFile(*file)
	if err != nil {
		return err
	}
	defer clearBytes(privateKey)
	vault := resourceVault(s)
	newRef, err := vault.Import(privateKey)
	if err != nil {
		return err
	}
	actionID, err := store.NewActionID()
	if err != nil {
		_ = vault.Delete(newRef)
		return err
	}
	if err := s.Mutate(ctx, func(m *store.Mutation) error {
		if _, err := m.SetCredentialRef(ctx, resource.ID, newRef); err != nil {
			return err
		}
		_, err := m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: lake.Name + "/" + resource.Name, Tool: "lake.res.identity", Risk: "none", Event: "completed", Detail: "ssh_identity_rotated"})
		return err
	}); err != nil {
		_ = vault.Delete(newRef)
		return err
	}
	if oldRef != "" && oldRef != newRef {
		if err := vault.Delete(oldRef); err != nil {
			fmt.Fprintf(errOut, "警告：旧凭据条目清理失败：%v\n", err)
		}
	}
	_, err = fmt.Fprintf(out, "已更新 %s/%s 的 SSH 私钥\n", lake.Name, resource.Name)
	return err
}

type tagFlags map[string]string

func (tags *tagFlags) String() string { return fmt.Sprint(map[string]string(*tags)) }

func (tags *tagFlags) Set(value string) error {
	key, val, ok := strings.Cut(value, "=")
	if !ok || strings.TrimSpace(key) == "" || strings.ContainsAny(key, " \t\n\r") {
		return fmt.Errorf("标签格式应为 键=值，收到 %q", value)
	}
	if *tags == nil {
		*tags = map[string]string{}
	}
	(*tags)[key] = val
	return nil
}

func addResource(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake res add 需要资源名")
	}
	path := args[0]
	f := flags("lake res add", errOut)
	sshAddress := f.String("ssh", "", "用户@主机[:端口]")
	identityPath := f.String("identity", "", "要导入 Lake 本地凭据目录的私钥文件绝对路径")
	env := f.String("env", "", "环境")
	var tags tagFlags
	f.Var(&tags, "tag", "键=值，可重复")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake res add 参数过多")
	}
	if *sshAddress == "" {
		return errors.New("lake res add 需要 --ssh")
	}
	ssh, err := parseSSH(*sshAddress)
	if err != nil {
		return err
	}
	var privateKey []byte
	if *identityPath != "" {
		privateKey, err = readIdentityFile(*identityPath)
		if err != nil {
			return err
		}
		defer clearBytes(privateKey)
	}
	lake, name, err := resourceParent(ctx, s, path)
	if err != nil {
		return err
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return err
	}
	var credentialRef string
	if len(privateKey) != 0 {
		credentialRef, err = resourceVault(s).Import(privateKey)
		clearBytes(privateKey)
		if err != nil {
			return err
		}
	}
	var resource store.Resource
	if err := s.Mutate(ctx, func(m *store.Mutation) error {
		var err error
		resource, err = m.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: name, Env: *env, Tags: tags, SSH: ssh})
		if err != nil {
			return err
		}
		if credentialRef != "" {
			if _, err := m.SetCredentialRef(ctx, resource.ID, credentialRef); err != nil {
				return err
			}
		}
		_, err = m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: lake.Name + "/" + name, Tool: "lake.res.add", Risk: "none", Event: "completed", Detail: "resource_id=" + resource.ID})
		return err
	}); err != nil {
		if credentialRef != "" {
			if cleanupErr := resourceVault(s).Delete(credentialRef); cleanupErr != nil {
				return fmt.Errorf("%w；清理未关联的凭据条目失败：%v", err, cleanupErr)
			}
		}
		return err
	}
	if *asJSON {
		return writeJSON(out, resourceView(lake.Name, resource))
	}
	_, err = fmt.Fprintf(out, "已存入资源 %s/%s (%s)\n", lake.Name, resource.Name, resource.ID)
	return err
}

func clearBytes(data []byte) {
	for i := range data {
		data[i] = 0
	}
}

func resourceParent(ctx context.Context, s *store.Store, path string) (store.Lake, string, error) {
	parts := strings.Split(path, "/")
	if len(parts) == 1 {
		lake, err := s.CurrentLake(ctx)
		return lake, parts[0], err
	}
	if len(parts) == 2 {
		lake, err := s.GetLakeByName(ctx, parts[0])
		return lake, parts[1], err
	}
	return store.Lake{}, "", fmt.Errorf("无效资源路径 %q", path)
}

func parseSSH(value string) (store.SSHSpec, error) {
	user, address, ok := strings.Cut(value, "@")
	if !ok || user == "" || address == "" {
		return store.SSHSpec{}, fmt.Errorf("SSH 地址格式应为 用户@主机[:端口]，收到 %q", value)
	}
	host, port := address, 22
	var portText string
	var err error
	if strings.HasPrefix(address, "[") {
		if strings.HasSuffix(address, "]") {
			host = strings.TrimSuffix(strings.TrimPrefix(address, "["), "]")
		} else {
			host, portText, err = net.SplitHostPort(address)
		}
	} else if strings.Count(address, ":") == 1 {
		host, portText, err = net.SplitHostPort(address)
	}
	if err != nil {
		return store.SSHSpec{}, fmt.Errorf("解析 SSH 地址: %w", err)
	}
	if strings.HasSuffix(address, ":") {
		return store.SSHSpec{}, errors.New("SSH 端口不能为空")
	}
	if portText != "" {
		port, err = strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return store.SSHSpec{}, fmt.Errorf("无效 SSH 端口 %q", portText)
		}
	}
	return store.SSHSpec{Host: host, Port: port, Username: user}, nil
}

func listResources(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	f := flags("lake res ls", errOut)
	lakeName := f.String("lake", "", "湖名")
	allLakes := f.Bool("all", false, "所有湖")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake res ls 参数过多")
	}
	if *allLakes {
		if *lakeName != "" {
			return errors.New("--all 与 --lake 不能同时使用")
		}
		lakes, err := s.ListLakes(ctx)
		if err != nil {
			return err
		}
		views := make([]any, 0)
		type namedResource struct {
			lake     string
			resource store.Resource
		}
		entries := make([]namedResource, 0)
		for _, item := range lakes {
			resources, err := s.ListResources(ctx, item.ID)
			if err != nil {
				return err
			}
			for _, resource := range resources {
				views = append(views, resourceView(item.Name, resource))
				entries = append(entries, namedResource{lake: item.Name, resource: resource})
			}
		}
		if *asJSON {
			return writeJSON(out, views)
		}
		w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintln(w, "LAKE\tNAME\tKIND\tENDPOINT\tENV\tEXECUTE_AUTHZ"); err != nil {
			return err
		}
		for _, item := range entries {
			if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%t\n", item.lake, item.resource.Name, item.resource.Kind, resourceEndpoint(item.resource), item.resource.Env, item.resource.ExecuteAuthz); err != nil {
				return err
			}
		}
		return w.Flush()
	}
	var lake store.Lake
	var err error
	if *lakeName == "" {
		lake, err = s.CurrentLake(ctx)
	} else {
		lake, err = s.GetLakeByName(ctx, *lakeName)
	}
	if err != nil {
		return err
	}
	resources, err := s.ListResources(ctx, lake.ID)
	if err != nil {
		return err
	}
	if *asJSON {
		views := make([]any, 0, len(resources))
		for _, resource := range resources {
			views = append(views, resourceView(lake.Name, resource))
		}
		return writeJSON(out, views)
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "NAME\tKIND\tENDPOINT\tENV\tEXECUTE_AUTHZ"); err != nil {
		return err
	}
	for _, resource := range resources {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%t\n", resource.Name, resource.Kind, resourceEndpoint(resource), resource.Env, resource.ExecuteAuthz); err != nil {
			return err
		}
	}
	return w.Flush()
}

func authorizeResource(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) > 0 && args[0] == "--all" {
		return authorizeAllResources(ctx, s, args[1:], out, errOut)
	}
	if len(args) < 2 {
		return errors.New("用法：lake res authz <资源> on|off [--json]；或 lake res authz --all on|off [--lake 湖名]")
	}
	path, mode := args[0], args[1]
	if mode != "on" && mode != "off" {
		return errors.New("授权状态必须是 on 或 off")
	}
	f := flags("lake res authz", errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[2:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake res authz 参数过多")
	}
	resource, err := s.ResolveResource(ctx, path)
	if err != nil {
		return err
	}
	lake, err := s.GetLake(ctx, resource.LakeID)
	if err != nil {
		return err
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return err
	}
	enabled := mode == "on"
	if err := s.Mutate(ctx, func(m *store.Mutation) error {
		var err error
		resource, err = m.SetExecuteAuthz(ctx, resource.ID, enabled)
		if err != nil {
			return err
		}
		_, err = m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: lake.Name + "/" + resource.Name, Tool: "lake.res.authz", Risk: "none", Event: "completed", Detail: fmt.Sprintf("execute_authz=%t", enabled)})
		return err
	}); err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, resourceView(lake.Name, resource))
	}
	_, err = fmt.Fprintf(out, "%s/%s execute_authz=%t\n", lake.Name, resource.Name, resource.ExecuteAuthz)
	return err
}

func authorizeAllResources(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 || (args[0] != "on" && args[0] != "off") {
		return errors.New("用法：lake res authz --all on|off [--lake 湖名] [--json]")
	}
	enabled := args[0] == "on"
	f := flags("lake res authz --all", errOut)
	lakeName := f.String("lake", "", "湖名，默认当前湖")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake res authz --all 参数过多")
	}
	var lake store.Lake
	var err error
	if *lakeName == "" {
		lake, err = s.CurrentLake(ctx)
	} else {
		lake, err = s.GetLakeByName(ctx, *lakeName)
	}
	if err != nil {
		return err
	}
	resources, err := s.ListResources(ctx, lake.ID)
	if err != nil {
		return err
	}
	if err := s.Mutate(ctx, func(m *store.Mutation) error {
		for i := range resources {
			actionID, err := store.NewActionID()
			if err != nil {
				return err
			}
			resources[i], err = m.SetExecuteAuthz(ctx, resources[i].ID, enabled)
			if err != nil {
				return err
			}
			_, err = m.AppendJournal(ctx, store.JournalInput{
				ActionID: actionID, Actor: "cli", TargetPath: lake.Name + "/" + resources[i].Name,
				Tool: "lake.res.authz", Risk: "none", Event: "completed",
				Detail: fmt.Sprintf("execute_authz=%t;bulk=true", enabled),
			})
			if err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if *asJSON {
		views := make([]any, 0, len(resources))
		for _, resource := range resources {
			views = append(views, resourceView(lake.Name, resource))
		}
		return writeJSON(out, views)
	}
	_, err = fmt.Fprintf(out, "湖 %s 的 %d 个资源已设置 execute_authz=%t（持久生效）\n", lake.Name, len(resources), enabled)
	return err
}

func listJournal(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	f := flags("lake journal", errOut)
	_ = f.Bool("tail", false, "最近记录")
	limit := f.Int("limit", 20, "最多显示条数")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("lake journal 参数过多")
	}
	entries, err := s.ListJournal(ctx, store.JournalFilter{Limit: *limit})
	if err != nil {
		return err
	}
	if *asJSON {
		views := make([]any, 0, len(entries))
		for _, entry := range entries {
			views = append(views, journalView(entry))
		}
		return writeJSON(out, views)
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "TIME\tACTOR\tEVENT\tTARGET\tTOOL\tDETAIL"); err != nil {
		return err
	}
	for _, entry := range entries {
		detail := strings.NewReplacer("\n", "\\n", "\r", "\\r", "\t", "\\t").Replace(entry.Detail)
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", entry.Timestamp.Local().Format(time.RFC3339), entry.Actor, entry.Event, entry.TargetPath, entry.Tool, detail); err != nil {
			return err
		}
	}
	return w.Flush()
}

func writeJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func lakeView(lake store.Lake) any {
	return map[string]any{"id": lake.ID, "name": lake.Name, "description": lake.Description, "created_at": lake.CreatedAt, "updated_at": lake.UpdatedAt}
}

func resourceView(lakeName string, resource store.Resource) any {
	view := map[string]any{"id": resource.ID, "lake_id": resource.LakeID, "lake": lakeName, "name": resource.Name, "kind": resource.Kind, "execute_authz": resource.ExecuteAuthz, "env": resource.Env, "tags": resource.Tags, "created_at": resource.CreatedAt, "updated_at": resource.UpdatedAt}
	if resource.Kind == "host" {
		view["ssh"] = resource.SSH
	}
	if resource.Kind == "k8s" {
		view["k8s"] = resource.K8s
	}
	if resource.Kind == "mysql" || resource.Kind == "postgres" || resource.Kind == "starrocks" {
		view["db"] = resource.DB
	}
	return view
}

func resourceEndpoint(resource store.Resource) string {
	if resource.Kind == "k8s" {
		return resource.K8s.Context + "/" + resource.K8s.Namespace
	}
	if resource.Kind == "mysql" || resource.Kind == "postgres" || resource.Kind == "starrocks" {
		return resource.DB.Username + "@" + net.JoinHostPort(resource.DB.Host, strconv.Itoa(resource.DB.Port)) + "/" + resource.DB.Name
	}
	return resource.SSH.Username + "@" + net.JoinHostPort(resource.SSH.Host, strconv.Itoa(resource.SSH.Port))
}

func journalView(entry store.JournalEntry) any {
	return map[string]any{"id": entry.ID, "timestamp": entry.Timestamp, "run_id": entry.RunID, "action_id": entry.ActionID, "actor": entry.Actor, "target_path": entry.TargetPath, "tool": entry.Tool, "risk": entry.Risk, "event": entry.Event, "detail": entry.Detail, "exit_code": entry.ExitCode, "duration_ms": entry.DurationMS}
}
