package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/joho/godotenv"
)

// 该程序调用 Jup Ultra GET /ultra/v1/order 接口，并输出原始响应

type ultraOrderResponse struct {
	Transaction               string `json:"transaction"`
	RequestId                 string `json:"requestId"`
	PrioritizationFeeLamports int    `json:"prioritizationFeeLamports"`
}

func order(inputMint, outputMint, amount string) (string, string, error) {
	_ = godotenv.Load("swap.env")
	apiKey := os.Getenv("JUPITER_API_KEY")
	taker := os.Getenv("TAKER_ADDRESS")

	if taker == "" {
		return "", "", fmt.Errorf("未找到 TAKER_ADDRESS，请在 swap.env 中设置钱包地址")
	}

	base := "https://api.jup.ag/ultra/v1/order"
	q := url.Values{}
	q.Set("inputMint", inputMint)
	q.Set("outputMint", outputMint)
	q.Set("amount", amount)
	q.Set("taker", taker)
	q.Set("excludeRouters", "jupiterz")
	endpoint := base + "?" + q.Encode()

	// HTTP client with timeout
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, endpoint, nil)
	if err != nil {
		return "", "", fmt.Errorf("构建请求失败: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("X-API-KEY", apiKey)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", fmt.Errorf("读取响应失败: %w", err)
	}

	// 打印状态码与响应体，确保数据100%真实
	fmt.Printf("HTTP %d\n", resp.StatusCode)
	fmt.Println(string(body))

	var parsed ultraOrderResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", "", fmt.Errorf("解析JSON失败: %w", err)
	}

	// 检查优先费是否超过限制
	maxFeeStr := os.Getenv("MAX_PRIORITIZATION_FEE_LAMPORTS")
	maxFee := 50000 // 默认值
	if maxFeeStr != "" {
		if parsedMaxFee, err := fmt.Sscanf(maxFeeStr, "%d", &maxFee); err != nil || parsedMaxFee != 1 {
			fmt.Printf("警告: MAX_PRIORITIZATION_FEE_LAMPORTS 解析失败，使用默认值 %d\n", maxFee)
		}
	}

	if parsed.PrioritizationFeeLamports > maxFee {
		return "", "", fmt.Errorf("优先费过高: %d lamports，超过限制 %d", parsed.PrioritizationFeeLamports, maxFee)
	}

	return parsed.Transaction, parsed.RequestId, nil
}
