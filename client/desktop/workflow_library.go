package main

import (
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/cloudwego/eino/lake/store"
)

func (a *App) WorkflowLibrary(payload string) (string, error) {
	if len(payload) > 8192 {
		return "", errors.New("目录请求过长")
	}
	var request store.WorkflowLibraryRequest
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return "", errors.New("目录请求无效")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return "", errors.New("目录请求只能包含一个对象")
	}
	data, err := a.taskStore()
	if err != nil {
		return "", err
	}
	defer data.Close()
	result, err := data.ManageWorkflowLibrary(a.ctx, request)
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(result)
	return string(body), err
}
