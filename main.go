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
	logMessage := fmt.Sprintf("[%s] %s", timestamp, message)

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
		logOutput("\n🛑 收到信号 %v，开始优雅关闭...\n", sig)
		globalCancel()
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
					// 去重：只处理一次
					if _, loaded := processedFiles.LoadOrStore(event.Name, true); !loaded {
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
	var ca, lastUpdatedFirst string
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

	// 不对 ca/last_updated_first 做强制校验：缺失则跳过对应参数

	// 构建命令（按存在的字段拼接参数）
	args := []string{"ts-node", "addLiquidity.ts", fmt.Sprintf("--pool=%s", poolAddress)}
	if ca != "" {
		args = append(args, fmt.Sprintf("--token=%s", ca))
	}
	if lastUpdatedFirst != "" {
		args = append(args, fmt.Sprintf("--last_updated_first=%s", lastUpdatedFirst))
	}
	cmd := exec.Command("npx", args...)

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
		log.Printf("❌ 执行addLiquidity.ts失败: %v", err)
		return
	}

	logOutput("✅ addLiquidity.ts执行成功\n")

	// 不再为单个池启动定时任务，改为全局定时任务处理所有池
	// 这里只记录日志，实际领取由全局定时任务处理
	logOutput("✅ 新增池已处理: %s，将由全局定时任务处理领取奖励\n", poolAddress)
}

// startGlobalClaimRewardsTicker 全局领取奖励定时任务，扫描data目录下所有JSON文件
func startGlobalClaimRewardsTicker() {
	logOutput("🕐 启动全局领取奖励定时任务（每分钟02秒和32秒）\n")

	// 计算到下一个02秒的时间
	now := time.Now()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	nextTarget02 := nextMinute.Add(2 * time.Second)  // 02秒
	nextTarget32 := nextMinute.Add(32 * time.Second) // 32秒

	// 如果当前时间已经过了这分钟的02秒，则等到下一分钟的02秒
	if now.After(nextTarget02) {
		nextTarget02 = nextTarget02.Add(time.Minute)
	}
	// 如果当前时间已经过了这分钟的32秒，则等到下一分钟的32秒
	if now.After(nextTarget32) {
		nextTarget32 = nextTarget32.Add(time.Minute)
	}

	// 选择最近的时间点
	var nextTarget time.Time
	if nextTarget02.Before(nextTarget32) {
		nextTarget = nextTarget02
	} else {
		nextTarget = nextTarget32
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

	// 然后每分钟的02秒和32秒执行
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
			// 在02秒和32秒时执行
			if second == 2 || second == 32 {
				executeGlobalClaimRewards()
			}
		}
	}
}

// executeGlobalClaimRewards 执行全局领取奖励
func executeGlobalClaimRewards() {
	logOutput("🔄 开始全局领取奖励 - %s\n", time.Now().Format("15:04:05"))

	// 获取data目录下所有JSON文件
	dataDir := "/Users/yqw/meteora_dlmm/data"
	files, err := os.ReadDir(dataDir)
	if err != nil {
		log.Printf("读取data目录失败: %v", err)
		return
	}

	poolCount := 0
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

		poolCount++
		logOutput("🔄 正在领取奖励: %s\n", poolAddress)
		runClaimRewards(poolAddress)
	}

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
		fetchPriceForToken(poolAddress, tokenAddress)

		// 添加延迟避免API限制
		time.Sleep(1100 * time.Millisecond)
	}

	logOutput("✅ 本轮价格获取完成 - %s\n", time.Now().Format("15:04:05"))
}

// 删除重试逻辑：不再保留 readFileWithRetry 和 runCmdWithRetry
