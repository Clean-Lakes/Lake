package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const maxWebResponseBytes = 1 << 20
const maxWebTextBytes = 64 << 10

type SearchHit struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

type WebSearchProvider interface {
	Search(context.Context, string) ([]SearchHit, error)
}

type WebPage struct {
	URL       string `json:"url"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Untrusted bool   `json:"untrusted"`
}

type WebFetcher struct {
	allowed map[string]bool
	client  *http.Client
}

type SearXNGProvider struct {
	endpoint *url.URL
	client   *http.Client
}

func validWebURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Scheme != "https" && u.Scheme != "http" {
		return nil, errors.New("无效的 Web URL")
	}
	if u.Scheme == "http" && !isLocalHost(u.Hostname()) {
		return nil, errors.New("远程 Web URL 必须使用 HTTPS")
	}
	return u, nil
}

func isLocalHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func boundedWebClient(allowLocal bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		var ips []net.IP
		if parsed := net.ParseIP(host); parsed != nil {
			ips = []net.IP{parsed}
		} else {
			resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, item := range resolved {
				ips = append(ips, item.IP)
			}
		}
		for _, ip := range ips {
			if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
				if !allowLocal || !isLocalHost(host) || !ip.IsLoopback() {
					continue
				}
			}
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		}
		return nil, errors.New("Web 目标地址不允许访问")
	}
	return &http.Client{Timeout: 10 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Web 跳转已禁止") }}
}

func NewWebFetcher(domains []string) (*WebFetcher, error) {
	if len(domains) == 0 || len(domains) > 32 {
		return nil, errors.New("需要 1 到 32 个允许的域名")
	}
	allowed := make(map[string]bool, len(domains))
	for _, name := range domains {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || len(name) > 253 || strings.ContainsAny(name, "/:@?#* \t\n") {
			return nil, errors.New("无效的允许域名")
		}
		allowed[name] = true
	}
	return &WebFetcher{allowed: allowed, client: boundedWebClient(true)}, nil
}

func (f *WebFetcher) Fetch(ctx context.Context, rawURL string) (WebPage, error) {
	if f == nil {
		return WebPage{}, errors.New("Web 抓取未配置")
	}
	u, err := validWebURL(rawURL)
	if err != nil {
		return WebPage{}, err
	}
	if !f.allowed[strings.ToLower(u.Hostname())] {
		return WebPage{}, errors.New("Web 域名不在允许列表")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return WebPage{}, err
	}
	req.Header.Set("Accept", "text/html,text/plain")
	resp, err := f.client.Do(req)
	if err != nil {
		return WebPage{}, errors.New("Web 抓取失败或目标地址不允许访问")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return WebPage{}, fmt.Errorf("Web 服务返回 HTTP %d", resp.StatusCode)
	}
	mediaType := strings.ToLower(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	if mediaType != "text/html" && mediaType != "text/plain" {
		return WebPage{}, errors.New("仅支持 HTML 或纯文本页面")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxWebResponseBytes+1))
	if err != nil {
		return WebPage{}, errors.New("Web 页面读取失败")
	}
	if len(data) > maxWebResponseBytes {
		return WebPage{}, errors.New("Web 页面超过 1 MiB")
	}
	content := string(data)
	if mediaType == "text/html" {
		content = plainHTML(content)
	}
	content = strings.Join(strings.Fields(content), " ")
	page := WebPage{URL: u.String(), Text: content, Untrusted: true}
	if len(page.Text) > maxWebTextBytes {
		page.Text = page.Text[:maxWebTextBytes]
		page.Truncated = true
	}
	return page, nil
}

func plainHTML(source string) string {
	root, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return ""
	}
	var out strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode {
			switch node.Data {
			case "script", "style", "noscript", "svg", "iframe":
				return
			}
		}
		if node.Type == html.TextNode {
			out.WriteString(node.Data)
			out.WriteByte(' ')
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return out.String()
}

func NewSearXNGProvider(rawEndpoint string) (*SearXNGProvider, error) {
	u, err := validWebURL(rawEndpoint)
	if err != nil {
		return nil, err
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("搜索服务地址不能包含查询参数")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(u.Path, "/search") {
		u.Path += "/search"
	}
	return &SearXNGProvider{endpoint: u, client: boundedWebClient(isLocalHost(u.Hostname()))}, nil
}

func (p *SearXNGProvider) Search(ctx context.Context, query string) ([]SearchHit, error) {
	if p == nil {
		return nil, errors.New("Web 搜索未配置")
	}
	query = strings.TrimSpace(query)
	if query == "" || len(query) > 500 {
		return nil, errors.New("搜索词为空或过长")
	}
	u := *p.endpoint
	params := url.Values{"q": {query}, "format": {"json"}}
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, errors.New("Web 搜索失败或目标地址不允许访问")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("搜索服务返回 HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<10+1))
	if err != nil {
		return nil, errors.New("搜索结果读取失败")
	}
	if len(data) > 512<<10 {
		return nil, errors.New("搜索结果过大")
	}
	var body struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, errors.New("搜索服务返回无效 JSON")
	}
	hits := make([]SearchHit, 0, 10)
	for _, item := range body.Results {
		if len(hits) == 10 {
			break
		}
		link, err := validWebURL(item.URL)
		if err != nil {
			continue
		}
		hits = append(hits, SearchHit{Title: limitWebString(item.Title, 300), URL: limitWebString(link.String(), 2048), Snippet: limitWebString(item.Content, 1000)})
	}
	return hits, nil
}

func limitWebString(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
