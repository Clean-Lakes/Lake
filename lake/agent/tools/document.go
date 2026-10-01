package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"rsc.io/pdf"
)

const maxPDFBytes = 8 << 20
const maxPDFTextBytes = 64 << 10

type PDFText struct {
	Path      string `json:"path"`
	Pages     int    `json:"pages"`
	FromPage  int    `json:"from_page"`
	ToPage    int    `json:"to_page"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// ReadPDF extracts only page text. It does not evaluate JavaScript, forms, links,
// annotations, or embedded files. Every input path stays inside the bound root.
func ReadPDF(root, relative string, fromPage, pageLimit int) (result PDFText, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = PDFText{}
			err = errors.New("PDF 解析失败")
		}
	}()
	if root == "" || relative == "" || filepath.IsAbs(relative) || filepath.Ext(strings.ToLower(relative)) != ".pdf" {
		return PDFText{}, errors.New("需要项目内的 PDF 相对路径")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return PDFText{}, errors.New("PDF 路径超出项目")
	}
	if fromPage < 1 || pageLimit < 1 || pageLimit > 10 {
		return PDFText{}, errors.New("PDF 页码或页数无效")
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return PDFText{}, err
	}
	canonicalRoot, err = filepath.Abs(canonicalRoot)
	if err != nil {
		return PDFText{}, err
	}
	target := filepath.Join(canonicalRoot, clean)
	for part := canonicalRoot; part != target; {
		rel, err := filepath.Rel(part, target)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			return PDFText{}, errors.New("PDF 路径超出项目")
		}
		part = filepath.Join(part, strings.Split(rel, string(filepath.Separator))[0])
		info, err := os.Lstat(part)
		if err != nil {
			return PDFText{}, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return PDFText{}, errors.New("不能读取符号链接 PDF")
		}
	}
	file, err := os.Open(target)
	if err != nil {
		return PDFText{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return PDFText{}, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxPDFBytes {
		return PDFText{}, errors.New("PDF 必须是不超过 8 MiB 的普通文件")
	}
	reader, err := pdf.NewReader(file, info.Size())
	if err != nil {
		return PDFText{}, fmt.Errorf("PDF 解析失败: %w", err)
	}
	pages := reader.NumPage()
	if pages < 1 || fromPage > pages {
		return PDFText{}, errors.New("PDF 页码超出范围")
	}
	toPage := fromPage + pageLimit - 1
	if toPage > pages {
		toPage = pages
	}
	result = PDFText{Path: filepath.ToSlash(clean), Pages: pages, FromPage: fromPage, ToPage: toPage}
	var output strings.Builder
	for pageNo := fromPage; pageNo <= toPage; pageNo++ {
		page := reader.Page(pageNo)
		items := page.Content().Text
		sort.SliceStable(items, func(i, j int) bool {
			if items[i].Y != items[j].Y {
				return items[i].Y > items[j].Y
			}
			return items[i].X < items[j].X
		})
		fmt.Fprintf(&output, "[第 %d 页]\n", pageNo)
		var previous *pdf.Text
		for _, item := range items {
			separator := ""
			if previous != nil {
				if previous.Y-item.Y > item.FontSize*0.4 {
					separator = "\n"
				} else if item.X-(previous.X+previous.W) > item.FontSize*0.2 {
					separator = " "
				}
			}
			if output.Len()+len(separator)+len(item.S) > maxPDFTextBytes {
				result.Truncated = true
				result.Text = output.String()
				return result, nil
			}
			output.WriteString(separator)
			output.WriteString(item.S)
			previous = &item
		}
		output.WriteByte('\n')
	}
	result.Text = output.String()
	return result, nil
}
