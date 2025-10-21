package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	// 初始化日志系统
	initLogging()

	// 定义命令行参数
	var (
		inputMint = flag.String("input", "", "输入代币的mint地址 (优先级最高)")
		maxFee    = flag.String("maxfee", "", "最大优先费用 (lamports)")
		help      = flag.Bool("help", false, "显示帮助信息")
	)

	// 检查特殊命令
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "encrypt":
			encryptPrivateKeyCLI()
			return
		case "help":
			showHelp()
			return
		}
	}

	// 解析命令行参数
	flag.Parse()

	// 显示帮助信息
	if *help {
		showHelp()
		return
	}

	Log("=== Jupiter Ultra 交易执行器 ===")

	// 1) 先获取持仓信息
	Log("\n=== 获取持仓信息 ===")
	holdings, err := GetHoldings()
	if err != nil {
		Error("获取持仓失败: %v", err)
		return
	}

	// 2) 获取交易参数
	Log("\n=== 交易参数设置 ===")

	// 从 swap.env 获取默认值
	defaultInputMint := os.Getenv("DEFAULT_INPUT_MINT")
	defaultOutputMint := os.Getenv("DEFAULT_OUTPUT_MINT")

	// 获取 inputMint (优先级：命令行参数 > 环境变量 > 用户输入)
	var finalInputMint string
	if *inputMint != "" {
		finalInputMint = *inputMint
		Log("使用命令行参数 inputMint: %s", finalInputMint)
	} else if defaultInputMint != "" {
		finalInputMint = defaultInputMint
		Log("使用环境变量 inputMint: %s", finalInputMint)
	} else {
		finalInputMint = getUserInput("请输入 inputMint: ")
	}

	var finalOutputMint, finalAmount string

	// 检查是否启用自动代币卖出模式
	autoSellMode := os.Getenv("AUTO_SELL_TOKEN_MODE")

	// 检查 inputMint 是否为 SOL
	if finalInputMint == "So11111111111111111111111111111111111111112" {
		// 如果是 SOL，设置 outputMint 和 amount
		if defaultOutputMint != "" {
			finalOutputMint = defaultOutputMint
			Log("使用环境变量 outputMint: %s", finalOutputMint)
		} else {
			finalOutputMint = getUserInput("请输入 outputMint: ")
		}
		finalAmount = getUserInput("请输入 amount: ")
	} else if autoSellMode == "true" || autoSellMode == "y" {
		// 自动卖出模式：如果是代币，查找该代币的余额
		Log("自动卖出模式已启用，检测到代币输入，正在查找余额...")

		// 查找指定代币的余额
		found := false
		for tokenMint, tokenAccounts := range holdings.Tokens {
			if tokenMint == finalInputMint {
				for _, account := range tokenAccounts {
					if account.UIAmount > 0 {
						finalAmount = account.Amount
						finalOutputMint = "So11111111111111111111111111111111111111112" // 自动设置为 SOL
						found = true
						Log("找到代币余额: %s (%.6f)", account.Amount, account.UIAmount)
						break
					}
				}
				break
			}
		}

		if !found {
			Error("未找到代币 %s 的余额或余额为0", finalInputMint)
			return
		}
	} else {
		// 普通模式：如果是代币，设置 outputMint 和 amount
		if defaultOutputMint != "" {
			finalOutputMint = defaultOutputMint
			Log("使用环境变量 outputMint: %s", finalOutputMint)
		} else {
			finalOutputMint = getUserInput("请输入 outputMint: ")
		}
		finalAmount = getUserInput("请输入 amount: ")
	}

	// 设置MAX_PRIORITIZATION_FEE_LAMPORTS (优先级：命令行参数 > 环境变量)
	if *maxFee != "" {
		os.Setenv("MAX_PRIORITIZATION_FEE_LAMPORTS", *maxFee)
		Log("使用命令行参数 MAX_PRIORITIZATION_FEE_LAMPORTS: %s", *maxFee)
	}

	// 显示用户输入的参数
	Log("\n=== 交易参数 ===")
	Log("Input Mint:  %s", finalInputMint)
	Log("Output Mint: %s", finalOutputMint)
	Log("Amount:      %s", finalAmount)
	if *maxFee != "" {
		Log("Max Fee:     %s lamports", *maxFee)
	}
	Log("================")
	Log("")

	// 3) 调用执行函数
	execute_order(finalInputMint, finalOutputMint, finalAmount)
}

// showHelp 显示帮助信息
func showHelp() {
	Log("=== Jupiter Ultra 交易执行器 ===")
	Log("用法:")
	Log("  go run .                           - 运行交易执行器")
	Log("  go run . encrypt                   - 加密PRIVATE_KEY")
	Log("  go run . help                      - 显示帮助信息")
	Log("")
	Log("命令行参数:")
	Log("  -input string                      - 输入代币的mint地址 (优先级最高)")
	Log("  -maxfee string                     - 最大优先费用 (lamports)")
	Log("  -help                              - 显示帮助信息")
	Log("")
	Log("参数优先级:")
	Log("  1. 命令行参数 (最高优先级)")
	Log("  2. 环境变量 (swap.env文件)")
	Log("  3. 用户输入")
	Log("")
	Log("示例:")
	Log("  go run . -input So11111111111111111111111111111111111111112")
	Log("  go run . -input your_token_mint_address -maxfee 1000000")
}

// getUserInput 获取用户输入
func getUserInput(prompt string) string {
	fmt.Print(prompt)
	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	input = strings.TrimSpace(input)
	return input
}
