package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/store"
)

type lakeOverviewOutput struct {
	TotalLakes     int                `json:"total_lakes"`
	TotalResources int                `json:"total_resources"`
	Lakes          []lakeOverviewItem `json:"lakes"`
}

type lakeOverviewItem struct {
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	ResourceCount int    `json:"resource_count"`
}

type resourceListInput struct {
	Lake string `json:"lake" jsonschema:"description=要查询具体资源的湖名；必须由用户明确指定，或用户明确说当前湖"`
}

type resourceListOutput struct {
	Lake      string             `json:"lake"`
	Resources []resourceListItem `json:"resources"`
}

type resourceListItem struct {
	Name         string            `json:"name"`
	Kind         string            `json:"kind"`
	SSH          string            `json:"ssh,omitempty"`
	K8sContext   string            `json:"k8s_context,omitempty"`
	Namespace    string            `json:"namespace,omitempty"`
	DatabaseHost string            `json:"database_host,omitempty"`
	DatabasePort int               `json:"database_port,omitempty"`
	DatabaseUser string            `json:"database_user,omitempty"`
	DatabaseName string            `json:"database_name,omitempty"`
	TLSMode      string            `json:"tls_mode,omitempty"`
	Environment  string            `json:"environment,omitempty"`
	Tags         map[string]string `json:"tags,omitempty"`
	ExecuteAuthz bool              `json:"execute_authz"`
}

func newLakeOverviewTool(s *store.Store) (tool.InvokableTool, error) {
	return utils.InferTool[struct{}, lakeOverviewOutput](
		"lake_overview",
		"查询所有湖的概况：湖的总数、资源总数、每个湖的资源数量。用户没有指定湖而询问资源情况时使用；不返回具体主机信息，不执行远端命令。",
		func(ctx context.Context, _ struct{}) (lakeOverviewOutput, error) {
			lakes, err := s.ListLakeResourceCounts(ctx)
			if err != nil {
				return lakeOverviewOutput{}, err
			}
			result := lakeOverviewOutput{TotalLakes: len(lakes), Lakes: make([]lakeOverviewItem, 0, len(lakes))}
			for _, lake := range lakes {
				result.TotalResources += lake.ResourceCount
				result.Lakes = append(result.Lakes, lakeOverviewItem{
					Name: lake.Name, Description: lake.Description, ResourceCount: lake.ResourceCount,
				})
			}
			return result, nil
		},
	)
}

func newLakeResourcesTool(s *store.Store) (tool.InvokableTool, error) {
	return utils.InferTool[resourceListInput, resourceListOutput](
		"lake_resources",
		"查询明确指定的湖内的具体资源，返回 SSH 主机、Kubernetes context 或数据库连接元数据，以及环境、标签和授权状态。必须传入湖名；未指定湖的资源概况请使用 lake_overview。不执行远端命令，也不返回密码。",
		func(ctx context.Context, in resourceListInput) (resourceListOutput, error) {
			name := strings.TrimSpace(in.Lake)
			if name == "" {
				return resourceListOutput{}, errors.New("需要明确指定湖名；未指定湖的资源概况请使用 lake_overview")
			}
			lake, err := s.GetLakeByName(ctx, name)
			if err != nil {
				return resourceListOutput{}, fmt.Errorf("查找湖 %q: %w", name, err)
			}
			resources, err := s.ListResources(ctx, lake.ID)
			if err != nil {
				return resourceListOutput{}, err
			}
			result := resourceListOutput{Lake: lake.Name, Resources: make([]resourceListItem, 0, len(resources))}
			for _, resource := range resources {
				item := resourceListItem{Name: resource.Name, Kind: resource.Kind, Environment: resource.Env, Tags: resource.Tags, ExecuteAuthz: resource.ExecuteAuthz}
				if resource.Kind == "host" {
					item.SSH = fmt.Sprintf("%s@%s:%d", resource.SSH.Username, resource.SSH.Host, resource.SSH.Port)
				}
				if resource.Kind == "k8s" {
					item.K8sContext = resource.K8s.Context
					item.Namespace = resource.K8s.Namespace
				}
				if resource.Kind == "mysql" || resource.Kind == "postgres" || resource.Kind == "starrocks" {
					item.DatabaseHost = resource.DB.Host
					item.DatabasePort = resource.DB.Port
					item.DatabaseUser = resource.DB.Username
					item.DatabaseName = resource.DB.Name
					item.TLSMode = resource.DB.TLSMode
				}
				result.Resources = append(result.Resources, item)
			}
			return result, nil
		},
	)
}
