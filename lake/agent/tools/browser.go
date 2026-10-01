package tools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
)

// BrowserFetcher deliberately exposes only bounded page text. It has no cookie
// jar, script runtime, local filesystem access, or Lake SSH credential access.
type BrowserFetcher interface {
	Fetch(context.Context, string) (WebPage, error)
}

type BrowserView struct {
	ID        string  `json:"id"`
	Page      WebPage `json:"page"`
	Untrusted bool    `json:"untrusted"`
}

type BrowserAdapter struct {
	mu       sync.Mutex
	fetcher  BrowserFetcher
	sessions map[string]WebPage
}

func NewBrowserAdapter(fetcher BrowserFetcher) (*BrowserAdapter, error) {
	if fetcher == nil {
		return nil, errors.New("浏览器页面读取器未配置")
	}
	return &BrowserAdapter{fetcher: fetcher, sessions: make(map[string]WebPage)}, nil
}

func (b *BrowserAdapter) Open(ctx context.Context, url string) (BrowserView, error) {
	b.mu.Lock()
	if len(b.sessions) >= 4 {
		b.mu.Unlock()
		return BrowserView{}, errors.New("浏览器会话不能超过 4 个")
	}
	b.mu.Unlock()
	page, err := b.fetcher.Fetch(ctx, url)
	if err != nil {
		return BrowserView{}, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return BrowserView{}, err
	}
	id := hex.EncodeToString(random[:])
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.sessions) >= 4 {
		return BrowserView{}, errors.New("浏览器会话不能超过 4 个")
	}
	b.sessions[id] = page
	return BrowserView{ID: id, Page: page, Untrusted: true}, nil
}

func (b *BrowserAdapter) Navigate(ctx context.Context, id, url string) (BrowserView, error) {
	b.mu.Lock()
	_, exists := b.sessions[id]
	b.mu.Unlock()
	if !exists {
		return BrowserView{}, errors.New("浏览器会话不存在或已关闭")
	}
	page, err := b.fetcher.Fetch(ctx, url)
	if err != nil {
		return BrowserView{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.sessions[id]; !exists {
		return BrowserView{}, errors.New("浏览器会话已关闭")
	}
	b.sessions[id] = page
	return BrowserView{ID: id, Page: page, Untrusted: true}, nil
}

func (b *BrowserAdapter) Snapshot(id string) (BrowserView, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	page, exists := b.sessions[id]
	if !exists {
		return BrowserView{}, errors.New("浏览器会话不存在或已关闭")
	}
	return BrowserView{ID: id, Page: page, Untrusted: true}, nil
}

func (b *BrowserAdapter) Close(id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.sessions[id]; !exists {
		return errors.New("浏览器会话不存在或已关闭")
	}
	delete(b.sessions, id)
	return nil
}

func (b *BrowserAdapter) CloseAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	clear(b.sessions)
}
