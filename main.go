package main

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type ProfitData struct {
	PoolAddress string                 `json:"poolAddress"`
	Data        map[string]interface{} `json:"data"`
}

var csvHeaders []string
var processedFiles sync.Map
var scheduledRewards sync.Map

func main() {
	csvPath := "/Users/yqw/dlmm_8_27/data/profit.csv"
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

	fmt.Printf("开始监听文件: %s\n", csvPath)
	fmt.Printf("开始监听目录: %s\n", dataDir)
	fmt.Printf("CSV字段数: %d\n", len(csvHeaders))
	fmt.Printf("当前行数: %d\n", currentLineCount)

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
					fmt.Printf("🔄 检测到 %d 行新增，开始处理...\n", newLineCount-currentLineCount)
					processNewLines(csvPath, dataDir, currentLineCount)
					currentLineCount = newLineCount
					fmt.Printf("📊 当前总行数: %d\n", currentLineCount)
				}
			}

			// 处理data目录中的新JSON文件（仅响应Create事件，带并发上限与去重）
			if strings.HasPrefix(event.Name, dataDir) && strings.HasSuffix(event.Name, ".json") {
				if event.Op&fsnotify.Create == fsnotify.Create {
					// 去重：只处理一次
					if _, loaded := processedFiles.LoadOrStore(event.Name, true); !loaded {
						fmt.Printf("🆕 检测到JSON文件事件: %s, 操作: %v\n", event.Name, event.Op)
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

		fmt.Printf("✅ 新增行已保存: %s -> %s\n", profitData.PoolAddress, jsonFilePath)
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
	fmt.Printf("🚀 执行命令: %s\n", strings.Join(cmd.Args, " "))

	// 执行命令并捕获输出（单次执行）
	output, err := cmd.CombinedOutput()

	// 实时显示输出
	fmt.Print(string(output))

	// 检查是否有错误
	if err != nil {
		log.Printf("❌ 执行addLiquidity.ts失败: %v", err)
		return
	}

	fmt.Printf("✅ addLiquidity.ts执行成功\n")

	// 使用池地址作为唯一键；仓位地址在执行时从 JSON 读取
	key := poolAddress
	if _, loaded := scheduledRewards.LoadOrStore(key, true); loaded {
		fmt.Printf("⏱️ 已存在定时任务: %s\n", key)
		return
	}
	fmt.Printf("⏱️ 启动领取奖励定时任务(每1分钟): pool=%s\n", poolAddress)
	go startClaimRewardsTicker(poolAddress)
}

// startClaimRewardsTicker 每分钟执行一次 claimAllRewards.ts
func startClaimRewardsTicker(poolAddress string) {
	key := poolAddress
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	// 立即执行一次；若获取不到 positionAddress，则停止任务并移除标记
	if ok := runClaimRewards(poolAddress); !ok {
		log.Printf("未读取到 positionAddress，停止定时领取: pool=%s", poolAddress)
		scheduledRewards.Delete(key)
		return
	}

	// 每分钟执行；若过程中读取不到 positionAddress，则停止任务并移除标记
	for range ticker.C {
		if ok := runClaimRewards(poolAddress); !ok {
			log.Printf("未读取到 positionAddress，停止定时领取: pool=%s", poolAddress)
			scheduledRewards.Delete(key)
			return
		}
	}
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
	fmt.Printf("▶️  执行领取奖励: %s (position 来自 JSON)\n", strings.Join(cmd.Args, " "))
	// 执行命令（单次执行）
	out, err := cmd.CombinedOutput()
	fmt.Print(string(out))
	if err != nil {
		log.Printf("领取奖励执行失败: %v", err)
	}
	return true
}

// 删除重试逻辑：不再保留 readFileWithRetry 和 runCmdWithRetry
