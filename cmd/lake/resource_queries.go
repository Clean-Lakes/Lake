package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/cloudwego/eino/lake/store"
)

// answerResourceInventory reads straightforward inventory questions from the
// data layer. The model must not be allowed to invent resource identities,
// addresses or authorization history for these requests.
func answerResourceInventory(ctx context.Context, s *store.Store, prompt string) (string, bool, error) {
	if answer, handled, err := answerMentionedResource(ctx, s, prompt); handled {
		return answer, true, err
	}
	if !isResourceInventoryQuestion(prompt) {
		return "", false, nil
	}
	lakes, err := s.ListLakes(ctx)
	if err != nil {
		return "", true, err
	}
	var selected *store.Lake
	matchedNames := 0
	for i := range lakes {
		if strings.Contains(prompt, lakes[i].Name) {
			// A shorter lake name may be part of a longer one. Prefer the
			// longest matching name instead of treating that as a comparison.
			if selected == nil || len(lakes[i].Name) > len(selected.Name) {
				selected = &lakes[i]
			}
			matchedNames++
		}
	}
	if matchedNames > 1 {
		for i := range lakes {
			if &lakes[i] != selected && strings.Contains(prompt, lakes[i].Name) && !strings.Contains(selected.Name, lakes[i].Name) {
				return "", false, nil // A comparison belongs to the model and tools.
			}
		}
	}
	if selected == nil && strings.Contains(prompt, "当前湖") {
		lake, err := s.CurrentLake(ctx)
		if err != nil {
			return "", true, err
		}
		selected = &lake
	}
	if selected != nil {
		return formatLakeInventory(ctx, s, *selected)
	}
	counts, err := s.ListLakeResourceCounts(ctx)
	if err != nil {
		return "", true, err
	}
	var total int
	for _, count := range counts {
		total += count.ResourceCount
	}
	var out strings.Builder
	fmt.Fprintf(&out, "共有 %d 个湖、%d 个资源。", len(counts), total)
	if len(counts) > 0 {
		out.WriteString("\n")
		w := tabwriter.NewWriter(&out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "LAKE\tRESOURCES")
		for _, count := range counts {
			fmt.Fprintf(w, "%s\t%d\n", count.Name, count.ResourceCount)
		}
		if err := w.Flush(); err != nil {
			return "", true, err
		}
	}
	return strings.TrimRight(out.String(), "\n"), true, nil
}

// An isolated @ mention displays the stored resource record without asking a
// model to infer its identity or making any connection to the host.
func answerMentionedResource(ctx context.Context, s *store.Store, prompt string) (string, bool, error) {
	reference := strings.TrimSpace(prompt)
	if !strings.HasPrefix(reference, "@") || strings.Count(reference, "/") != 1 {
		return "", false, nil
	}
	resource, err := s.ResolveResource(ctx, strings.TrimPrefix(reference, "@"))
	if err != nil {
		if strings.ContainsAny(reference, " \t\n") {
			return "", false, nil // A longer request belongs to the Agent.
		}
		if errors.Is(err, store.ErrNotFound) {
			return "没有找到资源 " + reference + "。", true, nil
		}
		return "", true, err
	}
	lake, err := s.GetLake(ctx, resource.LakeID)
	if err != nil {
		return "", true, err
	}
	var out strings.Builder
	fmt.Fprintf(&out, "资源：%s/%s\n类型：%s", lake.Name, resource.Name, resource.Kind)
	if resource.Kind == "host" {
		fmt.Fprintf(&out, "\nSSH：%s@%s:%d", resource.SSH.Username, resource.SSH.Host, resource.SSH.Port)
	}
	if resource.Kind == "k8s" {
		fmt.Fprintf(&out, "\nKubernetes context：%s\n默认 namespace：%s", resource.K8s.Context, resource.K8s.Namespace)
	}
	if resource.Kind == "mysql" || resource.Kind == "postgres" || resource.Kind == "starrocks" {
		fmt.Fprintf(&out, "\n连接：%s\nTLS：%s", resourceEndpoint(resource), resource.DB.TLSMode)
	}
	if resource.Env != "" {
		fmt.Fprintf(&out, "\n环境：%s", resource.Env)
	}
	if len(resource.Tags) > 0 {
		fmt.Fprintf(&out, "\n标签：%s", formatResourceTags(resource.Tags))
	}
	if resource.ExecuteAuthz {
		out.WriteString("\n执行授权：已开启")
	} else {
		out.WriteString("\n执行授权：未开启")
	}
	return out.String(), true, nil
}

func isResourceInventoryQuestion(prompt string) bool {
	lower := strings.ToLower(prompt)
	if !containsAny(lower, "资源", "主机", "服务器", "数据库", "集群") {
		return false
	}
	if containsAny(lower, "cpu", "内存", "磁盘", "uptime", "hostname", "ssh", "连接", "占用", "负载", "运行", "执行", "命令", "检查") {
		return false
	}
	return containsAny(lower,
		"有哪些", "有什么", "什么资源", "多少资源", "多少台", "几台", "资源列表", "资源情况", "查看资源", "看资源", "列出资源", "列一下资源")
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func formatLakeInventory(ctx context.Context, s *store.Store, lake store.Lake) (string, bool, error) {
	resources, err := s.ListResources(ctx, lake.ID)
	if err != nil {
		return "", true, err
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%s共有 %d 个资源。", lake.Name, len(resources))
	if len(resources) == 0 {
		return out.String(), true, nil
	}
	out.WriteString("\n")
	w := tabwriter.NewWriter(&out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tKIND\tENDPOINT\tENV\tTAGS\tEXECUTE_AUTHZ")
	for _, resource := range resources {
		endpoint := resourceEndpoint(resource)
		env := resource.Env
		if env == "" {
			env = "-"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%t\n",
			resource.Name, resource.Kind, endpoint, env, formatResourceTags(resource.Tags), resource.ExecuteAuthz)
	}
	if err := w.Flush(); err != nil {
		return "", true, err
	}
	return strings.TrimRight(out.String(), "\n"), true, nil
}

func formatResourceTags(tags map[string]string) string {
	if len(tags) == 0 {
		return "-"
	}
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+tags[key])
	}
	return strings.Join(parts, ",")
}
