package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

type kubeconfigSummary struct {
	CurrentContext string `json:"current-context"`
	Contexts       []struct {
		Name string `json:"name"`
	} `json:"contexts"`
}

func kubectlConfig(ctx context.Context, path string, args ...string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("kubeconfig 路径必须是绝对路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 4*1024*1024 {
		return nil, errors.New("kubeconfig 必须是非空普通文件且不超过 4 MB")
	}
	if _, err := exec.LookPath("kubectl"); err != nil {
		return nil, errors.New("需要先安装 kubectl")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "kubectl", append([]string{"--kubeconfig", path, "config"}, args...)...)
	output := boundedOutput{limit: 4*1024*1024 + 1}
	cmd.Stdout = &output
	err = cmd.Run()
	if err != nil {
		return nil, fmt.Errorf("读取 kubeconfig 失败: %w", err)
	}
	if output.Len() > 4*1024*1024 {
		return nil, errors.New("导出的 kubeconfig 超过 4 MB")
	}
	return output.Bytes(), nil
}

func kubeContexts(ctx context.Context, path string) (kubeconfigSummary, error) {
	data, err := kubectlConfig(ctx, path, "view", "--output=json")
	if err != nil {
		return kubeconfigSummary{}, err
	}
	var summary kubeconfigSummary
	if err := json.Unmarshal(data, &summary); err != nil {
		return summary, err
	}
	if len(summary.Contexts) == 0 {
		return summary, errors.New("kubeconfig 没有 context")
	}
	return summary, nil
}

func listKubeContexts(ctx context.Context, args []string, out, errOut io.Writer) error {
	f := flags("lake res k8s-contexts", errOut)
	file := f.String("kubeconfig", "", "kubeconfig 绝对路径")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *file == "" {
		return errors.New("用法：lake res k8s-contexts --kubeconfig 绝对路径")
	}
	summary, err := kubeContexts(ctx, *file)
	if err != nil {
		return err
	}
	return writeJSON(out, summary)
}

func addK8sResource(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake res add-k8s 需要资源名")
	}
	path := args[0]
	f := flags("lake res add-k8s", errOut)
	file := f.String("kubeconfig", "", "要复制到 Lake 的 kubeconfig 绝对路径")
	contextName := f.String("context", "", "Kubernetes context，默认使用 kubeconfig 当前 context")
	namespace := f.String("namespace", "default", "默认 namespace")
	env := f.String("env", "", "环境")
	var tags tagFlags
	f.Var(&tags, "tag", "键=值，可重复")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 || *file == "" {
		return errors.New("用法：lake res add-k8s <湖/资源名> --kubeconfig 绝对路径 [--context 名称] [--namespace 名称]")
	}
	summary, err := kubeContexts(ctx, *file)
	if err != nil {
		return err
	}
	selected := *contextName
	if selected == "" {
		selected = summary.CurrentContext
	}
	if selected == "" {
		return errors.New("kubeconfig 未设置当前 context；请传 --context")
	}
	found := false
	for _, item := range summary.Contexts {
		if item.Name == selected {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("kubeconfig 中没有 context %q", selected)
	}
	// Flatten and minify so Lake owns one self-contained context and does not
	// depend on the original certificate/key file paths.
	data, err := kubectlConfig(ctx, *file, "view", "--raw", "--flatten", "--minify", "--context", selected, "--output=json")
	if err != nil {
		return err
	}
	defer clearBytes(data)
	var imported kubeconfigSummary
	if err := json.Unmarshal(data, &imported); err != nil {
		return err
	}
	if imported.CurrentContext != selected || len(imported.Contexts) != 1 || imported.Contexts[0].Name != selected {
		return errors.New("无法将所选 context 独立导入 Lake")
	}
	lake, name, err := resourceParent(ctx, s, path)
	if err != nil {
		return err
	}
	vault := credential.FileVault{Root: s.Root()}
	ref, err := vault.ImportKubeconfig(data)
	if err != nil {
		return err
	}
	resource := store.Resource{}
	actionID, err := store.NewActionID()
	if err != nil {
		_ = vault.DeleteKubeconfig(ref)
		return err
	}
	err = s.Mutate(ctx, func(m *store.Mutation) error {
		resource, err = m.CreateK8s(ctx, store.ResourceInput{LakeID: lake.ID, Name: name, Env: *env, Tags: tags, K8s: store.K8sSpec{Context: selected, Namespace: *namespace}})
		if err != nil {
			return err
		}
		if _, err = m.SetCredentialRef(ctx, resource.ID, ref); err != nil {
			return err
		}
		_, err = m.AppendJournal(ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: lake.Name + "/" + name, Tool: "lake.res.add-k8s", Risk: "none", Event: "completed", Detail: "resource_id=" + resource.ID})
		return err
	})
	if err != nil {
		_ = vault.DeleteKubeconfig(ref)
		return err
	}
	if *asJSON {
		return writeJSON(out, resourceView(lake.Name, resource))
	}
	_, err = fmt.Fprintf(out, "已存入 Kubernetes 资源 %s/%s（context: %s）\n", lake.Name, name, strings.TrimSpace(selected))
	return err
}
