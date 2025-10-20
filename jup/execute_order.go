package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
)

type executeRequest struct {
	SignedTransaction string `json:"signedTransaction"`
	RequestID         string `json:"requestId"`
}

type executeResponse struct {
	Status    string `json:"status"`
	Signature string `json:"signature"`
	Code      int    `json:"code"`
	// 其余字段保留在 raw 打印中
}

func execute_order(inputMint, outputMint, amount string) {
	_ = godotenv.Load("swap.env")
	apiKey := os.Getenv("JUPITER_API_KEY")

	// 获取最大重试次数
	maxRetriesStr := os.Getenv("MAX_RETRY_ATTEMPTS")
	maxRetries := 5 // 默认值
	if maxRetriesStr != "" {
		if parsedRetries, err := fmt.Sscanf(maxRetriesStr, "%d", &maxRetries); err != nil || parsedRetries != 1 {
			fmt.Printf("警告: MAX_RETRY_ATTEMPTS 解析失败，使用默认值 %d\n", maxRetries)
		}
	}

	// 重试机制：最多尝试 maxRetries 次
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("\n=== 尝试 %d/%d ===\n", attempt, maxRetries)

		// 1) 获取签名后的交易与 requestId
		signedBase64, requestID, err := sign_transaction(inputMint, outputMint, amount)
		if err != nil {
			fmt.Println("签名阶段失败:", err)
			if attempt == maxRetries {
				fmt.Println("达到最大重试次数，退出")
				return
			}
			continue
		}

		// 显示 requestId
		fmt.Printf("RequestId: %s\n", requestID)

		// 2) 组装执行请求
		payload := executeRequest{
			SignedTransaction: signedBase64,
			RequestID:         requestID,
		}
		b, _ := json.Marshal(payload)

		endpoint := "https://api.jup.ag/ultra/v1/execute"
		client := &http.Client{Timeout: 60 * time.Second}
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(b))
		if err != nil {
			fmt.Println("构建请求失败:", err)
			if attempt == maxRetries {
				fmt.Println("达到最大重试次数，退出")
				return
			}
			continue
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")
		if apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
			req.Header.Set("X-API-KEY", apiKey)
		}

		// 3) 发送请求
		resp, err := client.Do(req)
		if err != nil {
			fmt.Println("请求失败:", err)
			if attempt == maxRetries {
				fmt.Println("达到最大重试次数，退出")
				return
			}
			continue
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			fmt.Println("读取响应失败:", err)
			if attempt == maxRetries {
				fmt.Println("达到最大重试次数，退出")
				return
			}
			continue
		}
		fmt.Printf("HTTP %d\n", resp.StatusCode)
		fmt.Println(string(body))

		// 4) 解析 status 与 signature，按分支输出
		var er executeResponse
		if err := json.Unmarshal(body, &er); err == nil {
			if er.Status == "Success" {
				fmt.Println("Swap successful:")
				pretty := &bytes.Buffer{}
				_ = json.Indent(pretty, body, "", "  ")
				fmt.Println(pretty.String())
				if er.Signature != "" {
					fmt.Printf("https://solscan.io/tx/%s\n", er.Signature)
				}
				return // 成功，退出重试循环
			} else {
				fmt.Println("Swap failed:")
				pretty := &bytes.Buffer{}
				_ = json.Indent(pretty, body, "", "  ")
				fmt.Println(pretty.String())
				if er.Signature != "" {
					fmt.Printf("https://solscan.io/tx/%s\n", er.Signature)
				}

				// 检查是否需要重试
				if attempt < maxRetries {
					fmt.Printf("交易失败，准备重试... (状态: %s, 代码: %d)\n", er.Status, er.Code)
					time.Sleep(2 * time.Second) // 等待2秒后重试
					continue
				} else {
					fmt.Println("达到最大重试次数，交易最终失败")
					return
				}
			}
		} else {
			fmt.Println("解析响应失败:", err)
			if attempt == maxRetries {
				fmt.Println("达到最大重试次数，退出")
				return
			}
			continue
		}
	}
}
