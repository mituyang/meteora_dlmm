package main

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

type ProfitData struct {
	PoolAddress string                 `json:"poolAddress"`
	Data        map[string]interface{} `json:"data"`
}

var csvHeaders []string
var processedFiles sync.Map

// 日志系统
var logFile *os.File
var logMutex sync.Mutex

// 初始化日志系统
func initLogging() error {
	dataDir := "/Users/yqw/meteora_dlmm/data/log"
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return fmt.Errorf("创建data目录失败: %v", err)
	}

	// 创建带时间戳的日志文件
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	logPath := filepath.Join(dataDir, fmt.Sprintf("app_%s.log", timestamp))

	var err error
	logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("创建日志文件失败: %v", err)
	}

	fmt.Printf("📝 日志文件已创建: %s\n", logPath)
	return nil
}

// 写入日志（同时输出到终端和文件）
func logOutput(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	timestamp := time.Now().Format("2006-01-02 15:04:05")
	logMessage := fmt.Sprintf("[%s] [main.go] %s", timestamp, message)

	// 输出到终端
	fmt.Print(message)

	// 写入日志文件
	logMutex.Lock()
	if logFile != nil {
		logFile.WriteString(logMessage)
		logFile.Sync()
	}
	logMutex.Unlock()
}

// 关闭日志系统
func closeLogging() {
	logMutex.Lock()
	if logFile != nil {
		logFile.Close()
		logFile = nil
	}
	logMutex.Unlock()
}

// 全局上下文和取消函数，用于优雅关闭
var (
	globalCtx    context.Context
	globalCancel context.CancelFunc
	shutdownWg   sync.WaitGroup
)

func main() {
	// 初始化日志系统
	if err := initLogging(); err != nil {
		log.Fatalf("初始化日志系统失败: %v", err)
	}
	defer closeLogging()

	// 创建可取消的上下文
	globalCtx, globalCancel = context.WithCancel(context.Background())
	defer globalCancel()

	// 设置信号处理
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// 启动信号处理goroutine
	go func() {
		sig := <-sigChan
		logOutput("\n🛑 收到信号 %v，强制终止程序...\n", sig)
		globalCancel()

		// 如果收到第二个信号，立即退出
		sig2 := <-sigChan
		logOutput("\n💀 收到第二个信号 %v，立即退出！\n", sig2)
		os.Exit(1)
	}()

	csvPath := "/Users/yqw/dlmm_8_27/data/auto_profit.csv"
	dataDir := "/Users/yqw/meteora_dlmm/data"

	// 确保data目录存在
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("创建data目录失败: %v", err)
	}

	// 读取CSV头部
	if err := readCSVHeaders(csvPath); err != nil {
		log.Fatalf("读取CSV头部失败: %v", err)
	}

	// 获取当前文件行数
	currentLineCount, err := getLineCount(csvPath)
	if err != nil {
		log.Fatalf("获取文件行数失败: %v", err)
	}

	logOutput("开始监听文件: %s\n", csvPath)
	logOutput("开始监听目录: %s\n", dataDir)
	logOutput("CSV字段数: %d\n", len(csvHeaders))
	logOutput("当前行数: %d\n", currentLineCount)

	// 启动价格获取定时任务
	shutdownWg.Add(1)
	go func() {
		defer shutdownWg.Done()
		startPriceFetcherTicker()
	}()

	// 启动全局领取奖励定时任务
	shutdownWg.Add(1)
	go func() {
		defer shutdownWg.Done()
		startGlobalClaimRewardsTicker()
	}()

	// 启动jupSwap定时任务
	shutdownWg.Add(1)
	go func() {
		defer shutdownWg.Done()
		startJupSwapTicker()
	}()

	// 创建文件监听器
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Fatalf("创建文件监听器失败: %v", err)
	}
	defer watcher.Close()

	// 监听CSV文件
	err = watcher.Add(csvPath)
	if err != nil {
		log.Fatalf("添加CSV文件监听失败: %v", err)
	}

	// 监听data目录
	err = watcher.Add(dataDir)
	if err != nil {
		log.Fatalf("添加data目录监听失败: %v", err)
	}

	// 并发控制：最多同时处理 N 个 JSON 任务
	const maxConcurrent = 20
	sem := make(chan struct{}, maxConcurrent)

	// 监听事件
	for {
		select {
		case <-globalCtx.Done():
			logOutput("🛑 收到关闭信号，停止文件监听...\n")
			watcher.Close()
			logOutput("⏳ 等待所有goroutine完成...\n")
			shutdownWg.Wait()
			logOutput("✅ 程序已优雅关闭\n")
			return
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}

			// 处理CSV文件写入事件
			if event.Name == csvPath && event.Op&fsnotify.Write == fsnotify.Write {
				// 文件被写入，检查是否有新行
				time.Sleep(200 * time.Millisecond) // 等待写入完成
				newLineCount, err := getLineCount(csvPath)
				if err != nil {
					continue
				}

				if newLineCount > currentLineCount {
					logOutput("🔄 检测到 %d 行新增，开始处理...\n", newLineCount-currentLineCount)
					processNewLines(csvPath, dataDir, currentLineCount)
					currentLineCount = newLineCount
					logOutput("📊 当前总行数: %d\n", currentLineCount)
				}
			}

			// 处理data目录中的新JSON文件（仅响应Create事件，带并发上限与去重）
			if strings.HasPrefix(event.Name, dataDir) && strings.HasSuffix(event.Name, ".json") {
				if event.Op&fsnotify.Create == fsnotify.Create {
					// 去重：基于文件路径+当前时间戳，确保删除后重新创建会再次处理
					currentTime := time.Now().UnixNano()
					fileKey := fmt.Sprintf("%s_%d", event.Name, currentTime)
					if _, loaded := processedFiles.LoadOrStore(fileKey, true); !loaded {
						logOutput("🆕 检测到JSON文件事件: %s, 操作: %v\n", event.Name, event.Op)
						time.Sleep(100 * time.Millisecond) // 等待文件写入完成
						// 占用并发令牌
						sem <- struct{}{}
						go func(path string) {
							defer func() { <-sem }()
							processNewJSONFile(path)
						}(event.Name)
					}
				}
			}

		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Printf("监听错误: %v", err)
		}
	}
}

func readCSVHeaders(csvPath string) error {
	file, err := os.Open(csvPath)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := csv.NewReader(file)
	headers, err := reader.Read()
	if err != nil {
		return err
	}

	csvHeaders = headers
	return nil
}

func getLineCount(filePath string) (int, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	count := 0
	for scanner.Scan() {
		count++
	}

	return count, scanner.Err()
}

func processNewLines(csvPath, dataDir string, lastLineCount int) {
	file, err := os.Open(csvPath)
	if err != nil {
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1 // 允许字段数量不一致

	// 跳过已处理的行
	for i := 0; i < lastLineCount; i++ {
		_, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				return
			}
			continue
		}
	}

	// 处理新行
	lineNum := lastLineCount + 1
	for {
		record, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				break
			}
			lineNum++
			continue
		}

		if len(record) < 1 {
			lineNum++
			continue
		}

		// 解析数据（保持原始字符串、不做清洗）
		profitData := parseCSVRecord(record)

		// 保存为JSON文件（poolAddress 缺失则用时间戳+行号命名）
		jsonFileName := fmt.Sprintf("%s.json", profitData.PoolAddress)
		if profitData.PoolAddress == "" {
			jsonFileName = fmt.Sprintf("row_%d_%d.json", time.Now().Unix(), lineNum)
		}
		jsonFilePath := filepath.Join(dataDir, jsonFileName)

		// 输出内容：原样 headers、原样 record、以及按表头映射的 data
		out := map[string]interface{}{
			"poolAddress": profitData.PoolAddress,
			"headers":     csvHeaders,
			"record":      record,
			"data":        profitData.Data,
		}

		jsonData, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			lineNum++
			continue
		}

		err = os.WriteFile(jsonFilePath, jsonData, 0644)
		if err != nil {
			lineNum++
			continue
		}

		logOutput("✅ 新增行已保存: %s -> %s\n", profitData.PoolAddress, jsonFilePath)
		lineNum++
	}
}

func parseCSVRecord(record []string) *ProfitData {
	if len(record) < 1 {
		return nil
	}

	// 创建数据映射
	data := make(map[string]interface{})

	// 将每个字段与对应的头部名称配对，保持原始字符串格式
	for i, value := range record {
		if i < len(csvHeaders) {
			header := csvHeaders[i]
			// 直接保存为字符串，不进行任何解析
			data[header] = value
		}
	}

	// 获取poolAddress
	poolAddress := ""
	if addr, exists := data["poolAddress"]; exists {
		if addrStr, ok := addr.(string); ok {
			poolAddress = addrStr
		}
	}

	if poolAddress == "" {
		return nil
	}

	return &ProfitData{
		PoolAddress: poolAddress,
		Data:        data,
	}
}

// processNewJSONFile 处理新创建的JSON文件，执行addLiquidity.ts命令
func processNewJSONFile(jsonFilePath string) {
	// 读取JSON文件（单次读取）
	jsonData, err := os.ReadFile(jsonFilePath)
	if err != nil {
		log.Printf("读取JSON文件失败: %s, 错误: %v", jsonFilePath, err)
		return
	}

	// 解析JSON数据
	var profitData ProfitData
	if err := json.Unmarshal(jsonData, &profitData); err != nil {
		log.Printf("解析JSON文件失败: %s, 错误: %v", jsonFilePath, err)
		return
	}

	// 提取所需参数
	poolAddress := profitData.PoolAddress
	if poolAddress == "" {
		log.Printf("JSON文件中缺少poolAddress: %s", jsonFilePath)
		return
	}

	// 从Data中提取ca和last_updated_first
	var ca, lastUpdatedFirst, total_quote_liquidity_first string
	if caValue, exists := profitData.Data["ca"]; exists {
		if caStr, ok := caValue.(string); ok {
			ca = caStr
		}
	}
	if lastUpdatedFirstValue, exists := profitData.Data["last_updated_first"]; exists {
		if lastUpdatedFirstStr, ok := lastUpdatedFirstValue.(string); ok {
			lastUpdatedFirst = lastUpdatedFirstStr
		}
	}
	if total_quote_liquidity_firstValue, exists := profitData.Data["total_quote_liquidity_first"]; exists {
		if total_quote_liquidity_firstStr, ok := total_quote_liquidity_firstValue.(string); ok {
			total_quote_liquidity_first = total_quote_liquidity_firstStr
		}
	}
	// 不对 ca/last_updated_first 做强制校验：缺失则跳过对应参数

	// 构建命令（按存在的字段拼接参数）
	args := []string{"ts-node", "addLiquidity.ts", fmt.Sprintf("--pool=%s", poolAddress)}
	if ca != "" {
		args = append(args, fmt.Sprintf("--token=%s", ca))
	}
	if lastUpdatedFirst != "" {
		args = append(args, fmt.Sprintf("--last_updated_first=%s", lastUpdatedFirst))
	}
	if total_quote_liquidity_first != "" {
		args = append(args, fmt.Sprintf("--total_quote_liquidity_first=%s", total_quote_liquidity_first))
	}
	// 创建带超时的上下文（5分钟超时）
	ctx, cancel := context.WithTimeout(globalCtx, 5*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "npx", args...)

	// 设置工作目录为当前目录
	cmd.Dir = "/Users/yqw/meteora_dlmm"

	// 执行命令
	logOutput("🚀 执行命令: %s\n", strings.Join(cmd.Args, " "))

	// 执行命令并捕获输出（单次执行）
	output, err := cmd.CombinedOutput()

	// 实时显示输出
	logOutput("%s", string(output))

	// 检查是否有错误
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			log.Printf("⏰ 执行addLiquidity.ts超时（5分钟）: %v", err)
		} else {
			log.Printf("❌ 执行addLiquidity.ts失败: %v", err)
		}
		return
	}

	logOutput("✅ addLiquidity.ts执行成功\n")

	// 不再为单个池启动定时任务，改为全局定时任务处理所有池
	// 这里只记录日志，实际领取由全局定时任务处理
	logOutput("✅ 新增池已处理: %s，将由全局定时任务处理领取奖励\n", poolAddress)
}

// startGlobalClaimRewardsTicker 全局领取奖励定时任务，扫描data目录下所有JSON文件
func startGlobalClaimRewardsTicker() {
	logOutput("🕐 启动全局领取奖励定时任务（每分钟10秒和40秒）\n")

	// 计算到下一个10秒和40秒的时间
	now := time.Now()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	nextTarget10 := nextMinute.Add(10 * time.Second) // 10秒
	nextTarget40 := nextMinute.Add(40 * time.Second) // 40秒

	// 如果当前时间已经过了这分钟的10秒，则等到下一分钟的10秒
	if now.After(nextTarget10) {
		nextTarget10 = nextTarget10.Add(time.Minute)
	}
	// 如果当前时间已经过了这分钟的40秒，则等到下一分钟的40秒
	if now.After(nextTarget40) {
		nextTarget40 = nextTarget40.Add(time.Minute)
	}

	// 选择最近的时间点
	var nextTarget time.Time
	if nextTarget10.Before(nextTarget40) {
		nextTarget = nextTarget10
	} else {
		nextTarget = nextTarget40
	}

	initialDelay := nextTarget.Sub(now)
	logOutput("⏰ 距离下次领取奖励还有: %v\n", initialDelay.Round(time.Second))

	// 等待到下一个时间点，但可以被取消
	select {
	case <-globalCtx.Done():
		logOutput("🛑 收到关闭信号，停止全局领取奖励定时任务\n")
		return
	case <-time.After(initialDelay):
		// 继续执行
	}

	// 立即执行一次
	executeGlobalClaimRewards()

	// 然后每分钟的10秒和40秒执行
	ticker := time.NewTicker(1 * time.Second) // 每秒检查一次
	defer ticker.Stop()

	for {
		select {
		case <-globalCtx.Done():
			logOutput("🛑 收到关闭信号，停止全局领取奖励定时任务\n")
			return
		case <-ticker.C:
			now := time.Now()
			second := now.Second()
			// 在10秒和40秒时执行
			if second == 10 || second == 40 {
				executeGlobalClaimRewards()
			}
		}
	}
}

// executeGlobalClaimRewards 执行全局领取奖励（并发执行，每个池间隔2秒）
func executeGlobalClaimRewards() {
	logOutput("🔄 开始全局领取奖励 - %s\n", time.Now().Format("15:04:05"))

	// 获取data目录下所有JSON文件
	dataDir := "/Users/yqw/meteora_dlmm/data"
	files, err := os.ReadDir(dataDir)
	if err != nil {
		log.Printf("读取data目录失败: %v", err)
		return
	}

	// 收集所有有效的池地址
	var validPools []string
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}

		// 提取poolAddress（去掉.json后缀）
		poolAddress := strings.TrimSuffix(file.Name(), ".json")

		// 检查是否有positionAddress
		positionAddress := readPositionFromPoolJSON(poolAddress)
		if positionAddress == "" {
			continue
		}

		validPools = append(validPools, poolAddress)
	}

	poolCount := len(validPools)
	if poolCount == 0 {
		logOutput("⚠️ 没有找到有效的池，跳过本轮领取奖励\n")
		return
	}

	logOutput("📊 找到 %d 个有效池，开始并发执行（间隔2秒）\n", poolCount)

	// 使用 WaitGroup 等待所有 goroutine 完成
	var wg sync.WaitGroup

	// 为每个池启动一个 goroutine，间隔2秒
	for i, poolAddress := range validPools {
		wg.Add(1)
		go func(index int, pool string) {
			defer wg.Done()

			// 计算延迟时间：每个池间隔2秒
			delay := time.Duration(index) * 2 * time.Second
			if delay > 0 {
				logOutput("⏳ 池 %s 等待 %v 后开始执行\n", pool, delay)
				time.Sleep(delay)
			}

			logOutput("🔄 正在领取奖励: %s (第 %d/%d 个池)\n", pool, index+1, poolCount)
			runClaimRewards(pool)
		}(i, poolAddress)
	}

	// 等待所有 goroutine 完成
	wg.Wait()

	logOutput("✅ 本轮全局领取奖励完成，处理了 %d 个池 - %s\n", poolCount, time.Now().Format("15:04:05"))
}

// runClaimRewards 执行领取奖励脚本

// 从 data/<pool>.json 读取 positionAddress（优先顶层，其次 data.positionAddress）
func readPositionFromPoolJSON(poolAddress string) string {
	dataPath := "/Users/yqw/meteora_dlmm/data/" + poolAddress + ".json"
	bytes, err := os.ReadFile(dataPath)
	if err != nil {
		log.Printf("读取池JSON失败: %s, 错误: %v", dataPath, err)
		return ""
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(bytes, &obj); err != nil {
		log.Printf("解析池JSON失败: %s, 错误: %v", dataPath, err)
		return ""
	}
	if v, ok := obj["positionAddress"].(string); ok && v != "" {
		return v
	}
	if m, ok := obj["data"].(map[string]interface{}); ok {
		if v, ok := m["positionAddress"].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func runClaimRewards(poolAddress string) bool {
	// 仅从 JSON 读取 positionAddress
	positionAddress := readPositionFromPoolJSON(poolAddress)
	if positionAddress == "" {
		// 返回 false 以通知上层停止定时任务
		return false
	}
	cmd := exec.Command("npx", "ts-node", "claimAllRewards.ts",
		fmt.Sprintf("--pool=%s", poolAddress),
	)
	cmd.Dir = "/Users/yqw/meteora_dlmm"
	logOutput("▶️  执行领取奖励: %s (position 来自 JSON)\n", strings.Join(cmd.Args, " "))
	// 执行命令（单次执行）
	out, err := cmd.CombinedOutput()
	logOutput("%s", string(out))
	if err != nil {
		log.Printf("领取奖励执行失败: %v", err)
	}
	return true
}

// 从 data/<pool>.json 读取 tokenContractAddress（ca字段）
func readTokenContractAddressFromPoolJSON(poolAddress string) string {
	dataPath := "/Users/yqw/meteora_dlmm/data/" + poolAddress + ".json"
	bytes, err := os.ReadFile(dataPath)
	if err != nil {
		log.Printf("读取池JSON失败: %s, 错误: %v", dataPath, err)
		return ""
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(bytes, &obj); err != nil {
		log.Printf("解析池JSON失败: %s, 错误: %v", dataPath, err)
		return ""
	}

	// 优先从顶层ca字段读取
	if v, ok := obj["ca"].(string); ok && v != "" {
		return v
	}

	// 其次从data.ca字段读取
	if m, ok := obj["data"].(map[string]interface{}); ok {
		if v, ok := m["ca"].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// 从 data/<pool>.json 读取 poolName
func readPoolNameFromPoolJSON(poolAddress string) string {
	dataPath := "/Users/yqw/meteora_dlmm/data/" + poolAddress + ".json"
	bytes, err := os.ReadFile(dataPath)
	if err != nil {
		return ""
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(bytes, &obj); err != nil {
		return ""
	}

	// 优先从顶层poolName字段读取
	if v, ok := obj["poolName"].(string); ok && v != "" {
		return v
	}

	// 其次从data.poolName字段读取
	if m, ok := obj["data"].(map[string]interface{}); ok {
		if v, ok := m["poolName"].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// 获取所有池的tokenContractAddress
func getAllTokenContractAddresses() map[string]string {
	tokenAddresses := make(map[string]string)
	dataDir := "/Users/yqw/meteora_dlmm/data"

	files, err := os.ReadDir(dataDir)
	if err != nil {
		log.Printf("读取data目录失败: %v", err)
		return tokenAddresses
	}

	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}

		// 提取poolAddress（去掉.json后缀）
		poolAddress := strings.TrimSuffix(file.Name(), ".json")
		tokenAddress := readTokenContractAddressFromPoolJSON(poolAddress)

		if tokenAddress != "" {
			tokenAddresses[poolAddress] = tokenAddress
		}
	}

	return tokenAddresses
}

// 通过 ca 反查 poolAddress（遍历 data 目录中每个池的 JSON，匹配顶层 ca 或 data.ca）

// 从 data/<pool>.json 读取 last_updated_first（优先顶层，其次 data.last_updated_first）
func readLastUpdatedFirstFromPoolJSON(poolAddress string) string {
	dataPath := "/Users/yqw/meteora_dlmm/data/" + poolAddress + ".json"
	bytes, err := os.ReadFile(dataPath)
	if err != nil {
		return ""
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(bytes, &obj); err != nil {
		return ""
	}
	if v, ok := obj["last_updated_first"].(string); ok && v != "" {
		return v
	}
	if m, ok := obj["data"].(map[string]interface{}); ok {
		if v, ok := m["last_updated_first"].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// 解析 last_updated_first（格式: 2006-01-02 15:04:05，按东八区解析）
func parseLastUpdatedFirstToTime(lastUpdatedFirst string) (time.Time, error) {
	lastUpdatedFirst = strings.TrimSpace(lastUpdatedFirst)
	if lastUpdatedFirst == "" {
		return time.Time{}, fmt.Errorf("empty last_updated_first")
	}
	// 支持包含 T 或 %20 的情况，替换为空格
	lastUpdatedFirst = strings.ReplaceAll(lastUpdatedFirst, "T", " ")
	lastUpdatedFirst = strings.ReplaceAll(lastUpdatedFirst, "%20", " ")
	// 去除可能包裹的引号
	lastUpdatedFirst = strings.Trim(lastUpdatedFirst, "\"'")

	loc, _ := time.LoadLocation("Asia/Shanghai")
	if loc == nil {
		loc = time.FixedZone("CST8", 8*60*60)
	}
	t, err := time.ParseInLocation("2006-01-02 15:04:05", lastUpdatedFirst, loc)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

// 执行价格获取命令（仅获取价格，不执行交易）
func fetchPriceForToken(poolAddress, tokenContractAddress string) {
	// 使用专门的价格获取脚本
	cmd := exec.Command("npx", "ts-node", "fetchPrice.ts",
		fmt.Sprintf("--pool=%s", poolAddress),
		fmt.Sprintf("--token=%s", tokenContractAddress))
	cmd.Dir = "/Users/yqw/meteora_dlmm"

	// 执行命令并捕获输出
	output, err := cmd.CombinedOutput()
	outputStr := string(output)

	// 实时显示所有输出到终端和日志文件
	logOutput("%s", outputStr)

	// 解析输出，提取价格信息
	var finalPrice string
	lines := strings.Split(outputStr, "\n")
	for _, line := range lines {
		if strings.Contains(line, "price:") {
			// 提取价格值
			parts := strings.Split(line, "price:")
			if len(parts) > 1 {
				finalPrice = strings.TrimSpace(parts[1])
			}
		}
	}

	// 获取poolName
	poolName := readPoolNameFromPoolJSON(poolAddress)
	if poolName == "" {
		poolName = "未知池"
	}

	// 输出价格信息
	if finalPrice != "" {
		logOutput("💰 最终价格: %s\n", finalPrice)
		logOutput("✅ 价格获取成功 [ca: %s, poolName: %s]\n", tokenContractAddress, poolName)
	} else {
		logOutput("❌ 价格获取失败 [ca: %s, poolName: %s]\n", tokenContractAddress, poolName)
		if err != nil {
			log.Printf("错误详情: %v", err)
		}
	}
}

// 启动价格获取定时任务
func startPriceFetcherTicker() {
	logOutput("🕐 启动价格获取定时任务（每分钟01秒）\n")

	// 计算到下一个01秒的时间
	now := time.Now()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	nextTarget := nextMinute.Add(time.Second) // 01秒

	// 如果当前时间已经过了这分钟的01秒，则等到下一分钟的01秒
	if now.After(nextTarget) {
		nextTarget = nextTarget.Add(time.Minute)
	}

	initialDelay := nextTarget.Sub(now)
	logOutput("⏰ 距离下次价格获取还有: %v\n", initialDelay.Round(time.Second))

	// 等待到下一个01秒，但可以被取消
	select {
	case <-globalCtx.Done():
		logOutput("🛑 收到关闭信号，停止价格获取定时任务\n")
		return
	case <-time.After(initialDelay):
		// 继续执行
	}

	// 立即执行一次
	executePriceFetch()

	// 然后每分钟的01秒执行
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-globalCtx.Done():
			logOutput("🛑 收到关闭信号，停止价格获取定时任务\n")
			return
		case <-ticker.C:
			executePriceFetch()
		}
	}
}

// 显示position存在时间
func displayPositionExistenceTime(poolAddress string) {
	// 读取 last_updated_first
	lastStr := readLastUpdatedFirstFromPoolJSON(poolAddress)
	if lastStr == "" {
		return // 没有时间信息，跳过显示
	}

	// 解析时间
	lastTime, err := parseLastUpdatedFirstToTime(lastStr)
	if err != nil {
		return // 解析失败，跳过显示
	}

	// 计算存在时间
	now := time.Now()
	existenceDuration := now.Sub(lastTime)
	existenceHours := existenceDuration.Hours()
	existenceMinutes := existenceDuration.Minutes()

	// 格式化显示
	var timeStr string
	if existenceHours >= 1 {
		timeStr = fmt.Sprintf("%.1f小时", existenceHours)
	} else {
		timeStr = fmt.Sprintf("%.0f分钟", existenceMinutes)
	}

	// 检查是否超过5小时
	var status string
	if existenceDuration >= 5*time.Hour {
		status = "🚨 已超时！需要立即移除"
	} else {
		remaining := 5*time.Hour - existenceDuration
		remainingMinutes := remaining.Minutes()
		status = fmt.Sprintf("⏳ 剩余%.0f分钟", remainingMinutes)
	}

	logOutput("📅 Position存在时间: %s (%s) - %s\n", timeStr, status, poolAddress)
}

// 检查并执行5小时超时移除流动性
func checkAndExecute5HourTimeout(poolAddress string) {
	// 读取 last_updated_first
	lastStr := readLastUpdatedFirstFromPoolJSON(poolAddress)
	if lastStr == "" {
		return // 没有时间信息，跳过检查
	}

	// 解析时间
	lastTime, err := parseLastUpdatedFirstToTime(lastStr)
	if err != nil {
		logOutput("⚠️ 解析 last_updated_first 失败 [pool: %s]: %v\n", poolAddress, err)
		return
	}

	// 检查是否超过5小时
	if time.Since(lastTime) >= 5*time.Hour {
		// 读取 positionAddress 并立即执行移除流动性
		positionAddress := readPositionFromPoolJSON(poolAddress)
		if positionAddress != "" {
			existenceDuration := time.Since(lastTime)
			existenceHours := existenceDuration.Hours()
			logOutput("🚨 检测到超时！Position已存在%.1f小时，立即执行移除流动性: pool=%s position=%s\n",
				existenceHours, poolAddress, positionAddress)

			// 立即执行移除流动性（同步执行，确保立即处理）
			rmCtx, rmCancel := context.WithTimeout(globalCtx, 2*time.Minute)
			defer rmCancel()

			rmCmd := exec.CommandContext(rmCtx, "npx", "ts-node", "removeLiquidity.ts",
				fmt.Sprintf("--pool=%s", poolAddress),
				fmt.Sprintf("--position=%s", positionAddress),
			)
			rmCmd.Dir = "/Users/yqw/meteora_dlmm"

			logOutput("🔄 正在执行移除流动性命令...\n")
			out, err := rmCmd.CombinedOutput()
			logOutput("%s", string(out))

			if err != nil {
				if rmCtx.Err() == context.DeadlineExceeded {
					logOutput("❌ 移除流动性超时（2分钟）[pool: %s]\n", poolAddress)
				} else if rmCtx.Err() == context.Canceled {
					logOutput("❌ 移除流动性被取消 [pool: %s]\n", poolAddress)
				} else {
					logOutput("❌ 移除流动性失败 [pool: %s]: %v\n", poolAddress, err)
				}
			} else {
				logOutput("✅ 移除流动性执行完成 [pool: %s]\n", poolAddress)
			}
		} else {
			logOutput("⚠️ 找不到 positionAddress，无法移除流动性: pool=%s\n", poolAddress)
		}
	}
}

// 执行价格获取
func executePriceFetch() {
	logOutput("🔄 开始价格获取 - %s\n", time.Now().Format("15:04:05"))

	tokenAddresses := getAllTokenContractAddresses()
	if len(tokenAddresses) == 0 {
		logOutput("⚠️ 未找到任何tokenContractAddress，跳过价格获取\n")
		return
	}

	logOutput("📊 找到 %d 个token需要获取价格\n", len(tokenAddresses))

	// 顺序获取所有token的价格（避免OKX API限制）
	for poolAddress, tokenAddress := range tokenAddresses {
		logOutput("🔄 正在获取价格: %s -> %s\n", poolAddress, tokenAddress)

		// 显示position存在时间
		displayPositionExistenceTime(poolAddress)

		// 检查5小时限制（在价格获取前检查）
		checkAndExecute5HourTimeout(poolAddress)

		fetchPriceForToken(poolAddress, tokenAddress)

		// 添加延迟避免API限制
		time.Sleep(1100 * time.Millisecond)
	}

	logOutput("✅ 本轮价格获取完成 - %s\n", time.Now().Format("15:04:05"))
}

// 启动jupSwap定时任务
func startJupSwapTicker() {
	logOutput("🕐 启动jupSwap定时任务（每分钟06秒）\n")

	// 计算到下一个06秒的时间
	now := time.Now()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	nextTarget := nextMinute.Add(6 * time.Second) // 06秒

	// 如果当前时间已经过了这分钟的06秒，则等到下一分钟的06秒
	if now.After(nextTarget) {
		nextTarget = nextTarget.Add(time.Minute)
	}

	initialDelay := nextTarget.Sub(now)
	logOutput("⏰ 距离下次jupSwap还有: %v\n", initialDelay.Round(time.Second))

	// 等待到下一个06秒，但可以被取消
	select {
	case <-globalCtx.Done():
		logOutput("🛑 收到关闭信号，停止jupSwap定时任务\n")
		return
	case <-time.After(initialDelay):
		// 继续执行
	}

	// 立即执行一次
	executeJupSwap()

	// 然后每分钟的06秒执行
	ticker := time.NewTicker(1 * time.Second) // 每秒检查一次
	defer ticker.Stop()

	for {
		select {
		case <-globalCtx.Done():
			logOutput("🛑 收到关闭信号，停止jupSwap定时任务\n")
			return
		case <-ticker.C:
			now := time.Now()
			second := now.Second()
			// 在06秒时执行
			if second == 6 {
				executeJupSwap()
			}
		}
	}
}

// 执行jupSwap
func executeJupSwap() {
	// 检查全局上下文是否已取消
	select {
	case <-globalCtx.Done():
		logOutput("⏹️ 程序已取消，跳过jupSwap\n")
		return
	default:
	}

	logOutput("🔄 开始jupSwap - %s\n", time.Now().Format("15:04:05"))

	// 先获取持仓信息，解析出所有代币地址
	tokenAddresses := getTokenBalancesFromJupSwap()
	if len(tokenAddresses) == 0 {
		logOutput("⚠️ 未找到任何代币持仓，跳过jupSwap\n")
		return
	}

	logOutput("📊 找到 %d 个代币需要执行swap\n", len(tokenAddresses))

	// 顺序执行所有代币的jupSwap（避免并发冲突）
	for i, tokenAddress := range tokenAddresses {
		// 检查全局上下文是否已取消
		select {
		case <-globalCtx.Done():
			logOutput("⏹️ 程序已取消，停止执行jupSwap\n")
			return
		default:
		}

		logOutput("🔄 正在执行jupSwap (%d/%d): %s\n", i+1, len(tokenAddresses), tokenAddress)
		executeJupSwapForToken(tokenAddress)

		// 添加延迟避免系统负载过高，但检查取消状态
		select {
		case <-globalCtx.Done():
			logOutput("⏹️ 程序已取消，停止执行jupSwap\n")
			return
		case <-time.After(2 * time.Second):
			// 继续下一个代币
		}
	}

	logOutput("✅ 本轮jupSwap完成 - %s\n", time.Now().Format("15:04:05"))
}

// 从jupSwap获取代币持仓信息
func getTokenBalancesFromJupSwap() []string {
	// 创建带超时的上下文
	ctx, cancel := context.WithTimeout(globalCtx, 30*time.Second)
	defer cancel()

	// 执行jupSwap命令获取持仓信息（不指定input参数）
	cmd := exec.CommandContext(ctx, "./jupSwap")
	cmd.Dir = "/Users/yqw/meteora_dlmm"

	// 执行命令并捕获输出
	output, err := cmd.CombinedOutput()
	outputStr := string(output)

	// 实时显示所有输出到终端和日志文件
	logOutput("%s", outputStr)

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			logOutput("❌ 获取持仓信息超时（30秒）\n")
		} else if ctx.Err() == context.Canceled {
			logOutput("❌ 获取持仓信息被取消\n")
		} else {
			logOutput("❌ 获取持仓信息失败: %v\n", err)
		}
		return []string{}
	}

	// 读取黑名单（每次执行时重新读取，支持动态更新）
	banList := readBanList()

	// 解析输出，提取代币地址
	tokenAddresses := parseTokenAddressesFromOutput(outputStr, banList)
	logOutput("📊 从持仓信息中解析出 %d 个代币地址（已过滤黑名单）\n", len(tokenAddresses))

	return tokenAddresses
}

// 读取黑名单ca地址
func readBanList() map[string]bool {
	banList := make(map[string]bool)
	banFilePath := "/Users/yqw/meteora_dlmm/data/ban/ban.csv"

	// 检查文件是否存在
	if _, err := os.Stat(banFilePath); os.IsNotExist(err) {
		logOutput("⚠️ 黑名单文件不存在: %s\n", banFilePath)
		return banList
	}

	// 读取文件内容
	content, err := os.ReadFile(banFilePath)
	if err != nil {
		logOutput("❌ 读取黑名单文件失败: %v\n", err)
		return banList
	}

	// 解析逗号分隔的ca地址（支持英文逗号和中文逗号）
	line := strings.TrimSpace(string(content))
	if line == "" {
		logOutput("📝 黑名单文件为空\n")
		return banList
	}

	// 先替换中文逗号为英文逗号，然后分割
	line = strings.ReplaceAll(line, "，", ",")
	addresses := strings.Split(line, ",")
	for _, addr := range addresses {
		addr = strings.TrimSpace(addr)
		if addr != "" {
			banList[addr] = true
			// logOutput("🚫 黑名单ca: %s\n", addr)
		}
	}

	logOutput("📊 加载了 %d 个黑名单ca\n", len(banList))
	return banList
}

// 从jupSwap输出中解析代币地址
func parseTokenAddressesFromOutput(output string, banList map[string]bool) []string {
	var tokenAddresses []string
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		// 查找包含"代币:"的行
		if strings.Contains(line, "代币:") {
			// 解析格式: "代币: AJ5WbjdWivswCGvyfMgbTjfSegCLHXJtXBTgjRhtsE1k, 余额: 183149994540 (183149.994540)"
			parts := strings.Split(line, "代币:")
			if len(parts) >= 2 {
				// 提取代币地址（去掉逗号前的部分）
				tokenPart := strings.TrimSpace(parts[1])
				commaIndex := strings.Index(tokenPart, ",")
				if commaIndex > 0 {
					tokenAddress := strings.TrimSpace(tokenPart[:commaIndex])
					// 验证地址格式（Solana地址通常是44个字符）
					if len(tokenAddress) >= 32 && len(tokenAddress) <= 44 {
						// 检查是否在黑名单中
						if banList[tokenAddress] {
							// logOutput("🚫 跳过黑名单代币: %s\n", tokenAddress)
						} else {
							tokenAddresses = append(tokenAddresses, tokenAddress)
							logOutput("🔍 发现代币: %s\n", tokenAddress)
						}
					}
				}
			}
		}
	}

	return tokenAddresses
}

// 读取中位数优先费用
func readMedianPrioritizationFee() string {
	swapFeePath := "/Users/yqw/meteora_dlmm/data/states/.swapFee.json"

	// 检查文件是否存在
	if _, err := os.Stat(swapFeePath); os.IsNotExist(err) {
		logOutput("⚠️ 交换费用文件不存在: %s\n", swapFeePath)
		return ""
	}

	// 读取文件内容
	content, err := os.ReadFile(swapFeePath)
	if err != nil {
		logOutput("❌ 读取交换费用文件失败: %v\n", err)
		return ""
	}

	// 解析JSON
	var swapFeeData struct {
		MedianPrioritizationFeeLamports int `json:"medianPrioritizationFeeLamports"`
		Q1PrioritizationFeeLamports     int `json:"q1PrioritizationFeeLamports"`
		Q3PrioritizationFeeLamports     int `json:"q3PrioritizationFeeLamports"`
	}

	if err := json.Unmarshal(content, &swapFeeData); err != nil {
		logOutput("❌ 解析交换费用JSON失败: %v\n", err)
		return ""
	}

	// 检查并设置默认值
	if swapFeeData.Q1PrioritizationFeeLamports == 0 {
		swapFeeData.Q1PrioritizationFeeLamports = 5000000
		logOutput("⚠️ q1为0或不存在，使用默认值: 5000000\n")
	}
	if swapFeeData.MedianPrioritizationFeeLamports == 0 {
		swapFeeData.MedianPrioritizationFeeLamports = 10000000
		logOutput("⚠️ medianPrioritizationFeeLamports为0或不存在，使用默认值: 10000000\n")
	}
	if swapFeeData.Q3PrioritizationFeeLamports == 0 {
		swapFeeData.Q3PrioritizationFeeLamports = 50000000
		logOutput("⚠️ q3为0或不存在，使用默认值: 50000000\n")
	}

	// 返回中位数费用作为字符串
	return fmt.Sprintf("%d", swapFeeData.MedianPrioritizationFeeLamports)
}

// 执行单个token的jupSwap
func executeJupSwapForToken(ca string) {
	// 检查全局上下文是否已取消
	select {
	case <-globalCtx.Done():
		logOutput("⏹️ 程序已取消，跳过代币: %s\n", ca)
		return
	default:
	}

	// 注意：5小时超时检查已移至价格获取定时任务中，避免重复检查

	// 创建带超时的上下文（每个代币最多30秒）
	ctx, cancel := context.WithTimeout(globalCtx, 30*time.Second)
	defer cancel()

	// 读取中位数优先费用
	maxFee := readMedianPrioritizationFee()
	if maxFee == "" {
		maxFee = "500000" // 默认值
		logOutput("⚠️ 无法读取中位数费用，使用默认值: %s\n", maxFee)
	} else {
		logOutput("💰 使用中位数优先费用: %s lamports\n", maxFee)
	}

	// 执行jupSwap命令
	cmd := exec.CommandContext(ctx, "./jupSwap", "-input", ca, "-maxfee", maxFee)
	cmd.Dir = "/Users/yqw/meteora_dlmm"

	// 执行命令并捕获输出
	output, err := cmd.CombinedOutput()
	outputStr := string(output)

	// 实时显示所有输出到终端和日志文件
	logOutput("%s", outputStr)

	// 检查执行结果
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			logOutput("❌ jupSwap执行超时（30秒）[ca: %s]\n", ca)
		} else if ctx.Err() == context.Canceled {
			logOutput("❌ jupSwap执行被取消 [ca: %s]\n", ca)
		} else {
			logOutput("❌ jupSwap执行失败 [ca: %s]: %v\n", ca, err)
		}
	} else {
		logOutput("✅ jupSwap执行成功 [ca: %s]\n", ca)
	}
}

// 删除重试逻辑：不再保留 readFileWithRetry 和 runCmdWithRetry
