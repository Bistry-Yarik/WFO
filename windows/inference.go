package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const ollamaEndpoint = "http://127.0.0.1:11434"

type inferenceMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type inferenceResult struct {
	Text  string `json:"text,omitempty"`
	Error string `json:"error,omitempty"`
}

func bindAlgaeInference(bind func(string, interface{}) error) error {
	var pending chan inferenceResult
	if err := bind("wfoStartAlgaeInference", func(messages []inferenceMessage) error {
		if pending != nil {
			return errors.New("Модель уже отвечает")
		}
		limit := 0
		for _, message := range messages {
			limit += len(message.Content)
		}
		if limit > 32*1024 {
			return errors.New("Слишком длинное сообщение")
		}
		result := make(chan inferenceResult, 1)
		pending = result
		go func() {
			text, err := promptOllama(messages)
			if err != nil {
				result <- inferenceResult{Error: err.Error()}
				return
			}
			result <- inferenceResult{Text: text}
		}()
		return nil
	}); err != nil {
		return err
	}
	return bind("wfoPollAlgaeInference", func() *inferenceResult {
		if pending == nil {
			return &inferenceResult{Error: "Нет активного запроса"}
		}
		select {
		case result := <-pending:
			pending = nil
			return &result
		default:
			return nil
		}
	})
}

func promptOllama(messages []inferenceMessage) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	client := http.Client{
		Transport:     &http.Transport{DisableKeepAlives: true},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	request := func(method, path string, body []byte, target interface{}) error {
		req, err := http.NewRequestWithContext(ctx, method, ollamaEndpoint+path, bytes.NewReader(body))
		if err != nil {
			return err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return errors.New("Ошибка локальной Ollama")
		}
		return json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(target)
	}
	var inventory struct {
		Models []struct {
			Name       string `json:"name"`
			Size       int64  `json:"size"`
			RemoteHost string `json:"remote_host"`
		} `json:"models"`
	}
	if err := request(http.MethodGet, "/api/tags", nil, &inventory); err != nil {
		return "", err
	}
	var model string
	for _, entry := range inventory.Models {
		if entry.Size <= 0 || entry.RemoteHost != "" || strings.Contains(strings.ToLower(entry.Name), "cloud") {
			continue
		}
		if model == "" {
			model = entry.Name
		}
		if strings.HasPrefix(strings.ToLower(entry.Name), "qwen") {
			model = entry.Name
			break
		}
	}
	if model == "" {
		return "", errors.New("Нет локальной модели Ollama")
	}
	body, err := json.Marshal(map[string]interface{}{
		"model": model, "messages": messages, "stream": false,
		"options": map[string]int{"num_predict": 160},
	})
	if err != nil {
		return "", err
	}
	var reply struct {
		Message inferenceMessage `json:"message"`
	}
	if err := request(http.MethodPost, "/api/chat", body, &reply); err != nil {
		return "", err
	}
	text := strings.TrimSpace(reply.Message.Content)
	if text == "" {
		return "", errors.New("Модель вернула пустой ответ")
	}
	return text, nil
}
