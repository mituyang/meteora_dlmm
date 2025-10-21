package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
)

// HoldingsResponse 表示持仓响应结构
type HoldingsResponse struct {
	Amount         string                 `json:"amount"`
	UIAmount       float64                `json:"uiAmount"`
	UIAmountString string                 `json:"uiAmountString"`
	Tokens         map[string][]TokenInfo `json:"tokens"`
	Error          string                 `json:"error,omitempty"`
}

// TokenInfo 表示代币信息
type TokenInfo struct {
	Account                  string  `json:"account"`
	Amount                   string  `json:"amount"`
	UIAmount                 float64 `json:"uiAmount"`
	UIAmountString           string  `json:"uiAmountString"`
	IsFrozen                 bool    `json:"isFrozen"`
	IsAssociatedTokenAccount bool    `json:"isAssociatedTokenAccount"`
	Decimals                 int     `json:"decimals"`
	ProgramID                string  `json:"programId"`
}

// GetHoldings 获取持仓信息（从 swap.env 读取钱包地址）
func GetHoldings() (*HoldingsResponse, error) {
	return GetHoldingsWithPrint(true)
}

// GetHoldingsWithPrint 获取持仓信息，可选择是否打印
func GetHoldingsWithPrint(shouldPrint bool) (*HoldingsResponse, error) {
	_ = godotenv.Load("swap.env")
	apiKey := os.Getenv("JUPITER_API_KEY")
	walletAddress := os.Getenv("TAKER_ADDRESS")

	if walletAddress == "" {
		return nil, fmt.Errorf("未找到 TAKER_ADDRESS，请在 swap.env 中设置钱包地址")
	}

	// 使用动态 API 端点
	endpoint := fmt.Sprintf("https://api.jup.ag/ultra/v1/holdings/%s", walletAddress)

	// HTTP client with timeout
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("构建请求失败: %w", err)
	}

	// 设置请求头
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("X-API-KEY", apiKey)
	}

	// 发送请求
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()

	// 读取响应
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}

	// 只打印原始响应体
	// fmt.Println(string(body))

	// 解析响应
	var holdings HoldingsResponse
	if err := json.Unmarshal(body, &holdings); err != nil {
		return nil, fmt.Errorf("解析JSON失败: %w", err)
	}

	// 检查是否有错误
	if holdings.Error != "" {
		return nil, fmt.Errorf("API错误: %s", holdings.Error)
	}

	// 解析并输出代币信息
	if shouldPrint {
		getHoldingsLogger.Log("SOL余额: %s lamports (%.9f SOL)", holdings.Amount, holdings.UIAmount)

		if len(holdings.Tokens) > 0 {
			getHoldingsLogger.Log("代币持仓:")
			for tokenMint, tokenAccounts := range holdings.Tokens {
				for _, account := range tokenAccounts {
					if account.UIAmount > 0 { // 只显示余额大于0的代币
						getHoldingsLogger.Log("代币: %s, 余额: %s (%.6f)", tokenMint, account.Amount, account.UIAmount)
					}
				}
			}
		}
	}

	return &holdings, nil
}
