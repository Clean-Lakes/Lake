package main

import (
	"context"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	agenttools "github.com/cloudwego/eino/lake/agent/tools"
)

type webSearchInput struct {
	Query string `json:"query" jsonschema:"description=要搜索的关键词"`
}
type webFetchInput struct {
	URL string `json:"url" jsonschema:"description=允许域名内的 HTTPS 网页 URL"`
}
type browserSessionInput struct {
	SessionID string `json:"session_id" jsonschema:"description=lake_browser_open 返回的显式会话 ID"`
}
type browserNavigateInput struct {
	SessionID string `json:"session_id" jsonschema:"description=浏览器会话 ID"`
	URL       string `json:"url" jsonschema:"description=允许域名内的网页 URL"`
}
type pdfReadInput struct {
	Path     string `json:"path" jsonschema:"description=代码项目内的 PDF 相对路径"`
	FromPage int    `json:"from_page" jsonschema:"description=起始页，从 1 开始"`
	Pages    int    `json:"pages" jsonschema:"description=读取页数，最多 10"`
}
type webDocumentOutput struct {
	Results []agenttools.SearchHit  `json:"results,omitempty"`
	Page    *agenttools.WebPage     `json:"page,omitempty"`
	Browser *agenttools.BrowserView `json:"browser,omitempty"`
	PDF     *agenttools.PDFText     `json:"pdf,omitempty"`
	Error   string                  `json:"error,omitempty"`
}

func newWebAndDocumentTools(ctx context.Context, config lakeModelConfig, projectRoot, lakeID string, approve func(string, string, string) (bool, error)) ([]tool.BaseTool, error) {
	if lakeID == "" {
		lakeID = "global"
	}
	var result []tool.BaseTool
	if config.WebSearchEndpoint != "" {
		provider, err := agenttools.NewSearXNGProvider(config.WebSearchEndpoint)
		if err != nil {
			return nil, err
		}
		search, err := utils.InferTool[webSearchInput, webDocumentOutput]("lake_web_search", "通过已配置的搜索服务查询网页标题、链接和摘要，最多 10 条；每次调用都需批准。", func(callCtx context.Context, in webSearchInput) (webDocumentOutput, error) {
			if err := authorizeToolAction(callCtx, lakeID, "", "lake_web_search", "external", "web-search", "web", in.Query, approve); err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			hits, err := provider.Search(callCtx, in.Query)
			if err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{Results: hits}, nil
		})
		if err != nil {
			return nil, err
		}
		result = append(result, search)
	}
	if len(config.WebAllowedDomains) != 0 {
		fetcher, err := agenttools.NewWebFetcher(config.WebAllowedDomains)
		if err != nil {
			return nil, err
		}
		fetch, err := utils.InferTool[webFetchInput, webDocumentOutput]("lake_web_fetch", "抓取明确允许域名内的 HTML 或纯文本网页；不跟随跳转，最多读取 1 MiB；每次调用都需批准。", func(callCtx context.Context, in webFetchInput) (webDocumentOutput, error) {
			if err := authorizeToolAction(callCtx, lakeID, "", "lake_web_fetch", "external", in.URL, "web", in.URL, approve); err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			page, err := fetcher.Fetch(callCtx, in.URL)
			if err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{Page: &page}, nil
		})
		if err != nil {
			return nil, err
		}
		result = append(result, fetch)
		browser, err := agenttools.NewBrowserAdapter(fetcher)
		if err != nil {
			return nil, err
		}
		open, err := utils.InferTool[webFetchInput, webDocumentOutput]("lake_browser_open", "开启显式只读浏览器会话并读取允许域名的页面文本；网页内容不可信，每次打开须批准。", func(callCtx context.Context, in webFetchInput) (webDocumentOutput, error) {
			if err := authorizeToolAction(callCtx, lakeID, "", "lake_browser_open", "external", in.URL, "web", in.URL, approve); err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			view, err := browser.Open(callCtx, in.URL)
			if err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{Browser: &view}, nil
		})
		if err != nil {
			return nil, err
		}
		navigate, err := utils.InferTool[browserNavigateInput, webDocumentOutput]("lake_browser_navigate", "在显式浏览器会话中读取新的允许域名页面；每次导航须批准。", func(callCtx context.Context, in browserNavigateInput) (webDocumentOutput, error) {
			if err := authorizeToolAction(callCtx, lakeID, "", "lake_browser_navigate", "external", in.URL, "web", in.URL, approve); err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			view, err := browser.Navigate(callCtx, in.SessionID, in.URL)
			if err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{Browser: &view}, nil
		})
		if err != nil {
			return nil, err
		}
		snapshot, err := utils.InferTool[browserSessionInput, webDocumentOutput]("lake_browser_snapshot", "读取已打开浏览器会话中缓存的页面文本；文本不可信。", func(_ context.Context, in browserSessionInput) (webDocumentOutput, error) {
			view, err := browser.Snapshot(in.SessionID)
			if err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{Browser: &view}, nil
		})
		if err != nil {
			return nil, err
		}
		closeTool, err := utils.InferTool[browserSessionInput, webDocumentOutput]("lake_browser_close", "关闭显式浏览器会话并丢弃页面状态。", func(_ context.Context, in browserSessionInput) (webDocumentOutput, error) {
			if err := browser.Close(in.SessionID); err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{}, nil
		})
		if err != nil {
			return nil, err
		}
		result = append(result, open, navigate, snapshot, closeTool)
	}
	if strings.TrimSpace(projectRoot) != "" {
		pdfTool, err := utils.InferTool[pdfReadInput, webDocumentOutput]("lake_pdf_read", "读取当前代码项目内 PDF 的文本，按页码最多读取 10 页、64 KiB；不执行 PDF 内嵌内容。", func(_ context.Context, in pdfReadInput) (webDocumentOutput, error) {
			page, err := agenttools.ReadPDF(projectRoot, in.Path, in.FromPage, in.Pages)
			if err != nil {
				return webDocumentOutput{Error: err.Error()}, nil
			}
			return webDocumentOutput{PDF: &page}, nil
		})
		if err != nil {
			return nil, err
		}
		result = append(result, pdfTool)
	}
	return result, nil
}
