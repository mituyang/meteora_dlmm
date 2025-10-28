package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// OrderResponse 定义API响应结构
type OrderResponse struct {
	Mode                      string      `json:"mode"`
	InputMint                 string      `json:"inputMint"`
	OutputMint                string      `json:"outputMint"`
	InAmount                  string      `json:"inAmount"`
	OutAmount                 string      `json:"outAmount"`
	OtherAmountThreshold      string      `json:"otherAmountThreshold"`
	SwapMode                  string      `json:"swapMode"`
	SlippageBps               int         `json:"slippageBps"`
	InUsdValue                float64     `json:"inUsdValue"`
	OutUsdValue               float64     `json:"outUsdValue"`
	PriceImpact               float64     `json:"priceImpact"`
	SwapUsdValue              float64     `json:"swapUsdValue"`
	PriceImpactPct            string      `json:"priceImpactPct"`
	RoutePlan                 []RoutePlan `json:"routePlan"`
	FeeMint                   string      `json:"feeMint"`
	FeeBps                    int         `json:"feeBps"`
	SignatureFeeLamports      int         `json:"signatureFeeLamports"`
	PrioritizationFeeLamports int         `json:"prioritizationFeeLamports"`
	RentFeeLamports           int         `json:"rentFeeLamports"`
	SwapType                  string      `json:"swapType"`
	Router                    string      `json:"router"`
	Transaction               string      `json:"transaction"`
	Gasless                   bool        `json:"gasless"`
	RequestId                 string      `json:"requestId"`
	TotalTime                 int         `json:"totalTime"`
	Taker                     string      `json:"taker"`
	QuoteId                   string      `json:"quoteId"`
	Maker                     string      `json:"maker"`
	ExpireAt                  string      `json:"expireAt"`
	PlatformFee               PlatformFee `json:"platformFee"`
	ErrorCode                 int         `json:"errorCode"`
	ErrorMessage              string      `json:"errorMessage"`
}

// RoutePlan 定义路由计划结构
type RoutePlan struct {
	SwapInfo SwapInfo `json:"swapInfo"`
	Percent  float64  `json:"percent"`
	Bps      int      `json:"bps"`
}

// SwapInfo 定义交换信息结构
type SwapInfo struct {
	AmmKey     string `json:"ammKey"`
	Label      string `json:"label"`
	InputMint  string `json:"inputMint"`
	OutputMint string `json:"outputMint"`
	InAmount   string `json:"inAmount"`
	OutAmount  string `json:"outAmount"`
	FeeAmount  string `json:"feeAmount"`
	FeeMint    string `json:"feeMint"`
}

// PlatformFee 定义平台费用结构
type PlatformFee struct {
	Amount string `json:"amount"`
	FeeBps int    `json:"feeBps"`
}

// ErrorResponse 定义错误响应结构
type ErrorResponse struct {
	Error string `json:"error"`
}

// FeeData 定义费用数据结构
type FeeData struct {
	Timestamp                 time.Time `json:"timestamp"`
	PrioritizationFeeLamports int       `json:"prioritizationFeeLamports"`
}

// SwapFeeData 定义交换费用数据结构
type SwapFeeData struct {
	MedianPrioritizationFeeLamports int `json:"medianPrioritizationFeeLamports"`
	Q1PrioritizationFeeLamports     int `json:"q1PrioritizationFeeLamports"` // 25%分位数
	Q3PrioritizationFeeLamports     int `json:"q3PrioritizationFeeLamports"` // 75%分位数
}

// 全局变量存储费用数据
var (
	feeDataList  []FeeData
	dataMutex    sync.RWMutex
	httpClient   *http.Client
	hasJsonFiles bool
	jsonMutex    sync.RWMutex
	ticker       *time.Ticker
	tickerMutex  sync.RWMutex
	logFile      *os.File
	logMutex     sync.Mutex
)

// logPrintf 同时输出到控制台和日志文件
func logPrintf(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)

	// 输出到控制台
	fmt.Print(message)

	// 输出到日志文件
	if logFile != nil {
		logMutex.Lock()
		logFile.WriteString(message)
		logMutex.Unlock()
	}
}

// initLogFile 初始化日志文件
func initLogFile() error {
	// 确保目录存在
	logDir := filepath.Join("..", "data", "log", "jupGetFee")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return fmt.Errorf("创建日志目录失败: %v", err)
	}

	// 生成带时间戳的日志文件名
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	logPath := filepath.Join(logDir, fmt.Sprintf("jupGetFee_%s.log", timestamp))

	// 创建新的日志文件
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("创建日志文件失败: %v", err)
	}

	logFile = file
	logPrintf("日志文件已创建: %s\n", logPath)
	return nil
}

// getPrioritizationFee 获取优先费用
func getPrioritizationFee() (int, error) {
	// API参数
	baseURL := "https://lite-api.jup.ag/ultra/v1/order"
	inputMint := "So11111111111111111111111111111111111111112"
	outputMint := "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
	amount := "100000000"
	excludeRouters := "jupiterz"
	taker := "FATnbSctYX3UjG4Cy9HxxGXUCCXGFvVe3WPAn3vQKw6E"

	// 构建URL
	u, err := url.Parse(baseURL)
	if err != nil {
		return 0, fmt.Errorf("解析URL失败: %v", err)
	}

	// 添加查询参数
	q := u.Query()
	q.Set("inputMint", inputMint)
	q.Set("outputMint", outputMint)
	q.Set("amount", amount)
	q.Set("excludeRouters", excludeRouters)
	q.Set("taker", taker)
	u.RawQuery = q.Encode()

	// 发送HTTP GET请求
	resp, err := httpClient.Get(u.String())
	if err != nil {
		return 0, fmt.Errorf("发送请求失败: %v", err)
	}
	defer resp.Body.Close()

	// 读取响应体
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("读取响应失败: %v", err)
	}

	// 检查HTTP状态码
	if resp.StatusCode != http.StatusOK {
		var errorResp ErrorResponse
		if err := json.Unmarshal(body, &errorResp); err != nil {
			return 0, fmt.Errorf("HTTP错误 %d: %s", resp.StatusCode, string(body))
		} else {
			return 0, fmt.Errorf("API错误: %s", errorResp.Error)
		}
	}

	// 解析JSON响应
	var orderResp OrderResponse
	if err := json.Unmarshal(body, &orderResp); err != nil {
		return 0, fmt.Errorf("解析JSON失败: %v", err)
	}

	return orderResp.PrioritizationFeeLamports, nil
}

// calculateMedian 计算中位数
func calculateMedian(data []int) int {
	if len(data) == 0 {
		return 0
	}

	sort.Ints(data)
	n := len(data)

	if n%2 == 0 {
		return (data[n/2-1] + data[n/2]) / 2
	}
	return data[n/2]
}

// calculateQuartiles 计算三分位数（Q1: 25%, Q2: 50%, Q3: 75%）
func calculateQuartiles(data []int) (int, int, int) {
	if len(data) == 0 {
		return 0, 0, 0
	}

	sort.Ints(data)
	n := len(data)

	// Q1 (25%分位数)
	var q1 int
	q1Index := n / 4
	if n%4 == 0 && q1Index > 0 {
		q1 = (data[q1Index-1] + data[q1Index]) / 2
	} else {
		q1 = data[q1Index]
	}

	// Q2 (50%分位数，即中位数)
	q2 := calculateMedian(data)

	// Q3 (75%分位数)
	var q3 int
	q3Index := 3 * n / 4
	if (3*n)%4 == 0 && q3Index > 0 {
		q3 = (data[q3Index-1] + data[q3Index]) / 2
	} else {
		q3 = data[q3Index]
	}

	return q1, q2, q3
}

// saveQuartilesToFile 保存三分位数据到文件
func saveQuartilesToFile(q1, q2, q3 int) error {
	// 确保目录存在
	dir := filepath.Join("..", "data", "states")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %v", err)
	}

	// 创建数据
	data := SwapFeeData{
		MedianPrioritizationFeeLamports: q2, // Q2是中位数
		Q1PrioritizationFeeLamports:     q1, // Q1是25%分位数
		Q3PrioritizationFeeLamports:     q3, // Q3是75%分位数
	}

	// 序列化为JSON
	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化JSON失败: %v", err)
	}

	// 写入文件
	filePath := filepath.Join(dir, ".swapFee.json")
	if err := os.WriteFile(filePath, jsonData, 0644); err != nil {
		return fmt.Errorf("写入文件失败: %v", err)
	}

	return nil
}

// hasJsonFilesInDataDir 检查data文件夹下是否存在JSON文件（不包括子文件夹）
func hasJsonFilesInDataDir() bool {
	dataDir := filepath.Join("..", "data")

	// 检查data目录是否存在
	if _, err := os.Stat(dataDir); os.IsNotExist(err) {
		return false
	}

	// 只读取data目录下的直接文件，不递归子目录
	files, err := os.ReadDir(dataDir)
	if err != nil {
		return false
	}

	// 检查是否有JSON文件
	for _, file := range files {
		if !file.IsDir() && strings.HasSuffix(strings.ToLower(file.Name()), ".json") {
			return true
		}
	}

	return false
}

// startTicker 启动定时器
func startTicker() {
	tickerMutex.Lock()
	defer tickerMutex.Unlock()

	if ticker != nil {
		ticker.Stop()
	}

	ticker = time.NewTicker(10 * time.Second)
	logPrintf("[%s] 启动定时器，每10秒获取一次API\n", time.Now().Format("15:04:05"))

	go func() {
		for range ticker.C {
			if getJsonFilesStatus() {
				runOnce()
			}
		}
	}()
}

// stopTicker 停止定时器并清空数据
func stopTicker() {
	tickerMutex.Lock()
	defer tickerMutex.Unlock()

	if ticker != nil {
		ticker.Stop()
		ticker = nil
		logPrintf("[%s] 停止定时器\n", time.Now().Format("15:04:05"))

		// 清空之前收集的数据
		dataMutex.Lock()
		feeDataList = []FeeData{}
		dataMutex.Unlock()
		logPrintf("[%s] 已清空历史数据，下次启动将使用全新数据\n", time.Now().Format("15:04:05"))
	}
}

// updateJsonFilesStatus 更新JSON文件状态
func updateJsonFilesStatus() {
	hasJson := hasJsonFilesInDataDir()
	jsonMutex.Lock()
	oldStatus := hasJsonFiles
	hasJsonFiles = hasJson
	jsonMutex.Unlock()

	// 如果状态发生变化，启动或停止定时器
	if oldStatus != hasJson {
		if hasJson {
			logPrintf("[%s] 检测到JSON文件，启动定时器\n", time.Now().Format("15:04:05"))
			startTicker()
		} else {
			logPrintf("[%s] JSON文件消失，停止定时器\n", time.Now().Format("15:04:05"))
			stopTicker()
		}
	}
}

// getJsonFilesStatus 获取当前JSON文件状态
func getJsonFilesStatus() bool {
	jsonMutex.RLock()
	defer jsonMutex.RUnlock()
	return hasJsonFiles
}

// startFileWatcher 启动文件系统监听（只监听data目录本身，不包括子目录）
func startFileWatcher() (*fsnotify.Watcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("创建文件监听器失败: %v", err)
	}

	dataDir := filepath.Join("..", "data")

	// 只监听data目录本身，不包括子目录
	if err := watcher.Add(dataDir); err != nil {
		watcher.Close()
		return nil, fmt.Errorf("添加监听目录失败 %s: %v", dataDir, err)
	}

	logPrintf("开始监听目录: %s\n", dataDir)

	// 启动监听协程
	go func() {
		defer watcher.Close()

		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}

				// 只处理data目录下的JSON文件事件（不包括子目录）
				if strings.HasSuffix(strings.ToLower(event.Name), ".json") &&
					filepath.Dir(event.Name) == dataDir {
					logPrintf("[%s] 检测到JSON文件变化: %s %s\n",
						time.Now().Format("15:04:05"), event.Op.String(), event.Name)

					// 更新JSON文件状态（会自动启动或停止定时器）
					updateJsonFilesStatus()
				}

			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				logPrintf("[%s] 文件监听错误: %v\n", time.Now().Format("15:04:05"), err)
			}
		}
	}()

	return watcher, nil
}

// cleanupOldData 清理5分钟前的数据
func cleanupOldData() {
	dataMutex.Lock()
	defer dataMutex.Unlock()

	cutoff := time.Now().Add(-5 * time.Minute)
	var newData []FeeData

	for _, data := range feeDataList {
		if data.Timestamp.After(cutoff) {
			newData = append(newData, data)
		}
	}

	feeDataList = newData
}

func main() {
	// 初始化日志文件
	if err := initLogFile(); err != nil {
		fmt.Printf("初始化日志文件失败: %v\n", err)
		return
	}
	defer func() {
		if logFile != nil {
			logFile.Close()
		}
	}()

	logPrintf("开始事务级别监控PrioritizationFeeLamports...\n")
	logPrintf("使用文件系统监听，实时检测data目录下JSON文件变化\n")
	logPrintf("只监听data目录本身，不包括子文件夹（如data/log、data/binArrays等）\n")
	logPrintf("当检测到JSON文件时，启动定时器每10秒获取一次API\n")
	logPrintf("当JSON文件消失时，停止定时器但继续监听\n")
	logPrintf("按Ctrl+C停止程序\n")

	// 初始化HTTP客户端（复用连接）
	httpClient = &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        10,
			MaxIdleConnsPerHost: 2,
			IdleConnTimeout:     30 * time.Second,
		},
	}
	defer httpClient.CloseIdleConnections()

	// 启动文件系统监听
	watcher, err := startFileWatcher()
	if err != nil {
		logPrintf("启动文件监听失败: %v\n", err)
		return
	}
	defer watcher.Close()

	// 初始化JSON文件状态（会自动启动或停止定时器）
	updateJsonFilesStatus()

	if getJsonFilesStatus() {
		logPrintf("[%s] 初始状态：检测到JSON文件，定时器已启动\n", time.Now().Format("15:04:05"))
	} else {
		logPrintf("[%s] 初始状态：data文件夹下没有JSON文件，等待文件变化...\n", time.Now().Format("15:04:05"))
	}

	// 保持程序运行
	select {}
}

// runOnce 执行一次获取和保存操作
func runOnce() {
	logPrintf("[%s] 开始请求API...\n", time.Now().Format("15:04:05"))

	// 获取优先费用
	fee, err := getPrioritizationFee()
	if err != nil {
		logPrintf("[%s] 获取费用失败: %v\n", time.Now().Format("15:04:05"), err)
		// API失败时，直接保存默认值
		q1, q2, q3 := 5000000, 10000000, 50000000
		if err := saveQuartilesToFile(q1, q2, q3); err != nil {
			logPrintf("[%s] 保存默认值失败: %v\n", time.Now().Format("15:04:05"), err)
		} else {
			logPrintf("[%s] API失败，已保存默认值: Q1=%d, Q2=%d, Q3=%d\n",
				time.Now().Format("15:04:05"), q1, q2, q3)
		}
		return
	}

	// 实时输出
	logPrintf("[%s] Prioritization Fee Lamports: %d\n", time.Now().Format("15:04:05"), fee)

	// 添加到数据列表（线程安全）
	dataMutex.Lock()
	feeDataList = append(feeDataList, FeeData{
		Timestamp:                 time.Now(),
		PrioritizationFeeLamports: fee,
	})
	dataMutex.Unlock()

	// 清理旧数据
	cleanupOldData()

	// 计算三分位数（线程安全）
	dataMutex.RLock()
	var fees []int
	for _, data := range feeDataList {
		fees = append(fees, data.PrioritizationFeeLamports)
	}
	dataMutex.RUnlock()

	q1, q2, q3 := calculateQuartiles(fees)

	// 设置最小值：如果为0，则设置默认值
	if q1 == 0 {
		q1 = 5000000
	}
	if q2 == 0 {
		q2 = 10000000
	}
	if q3 == 0 {
		q3 = 50000000
	}

	// 保存三分位数据到文件
	if err := saveQuartilesToFile(q1, q2, q3); err != nil {
		logPrintf("[%s] 保存文件失败: %v\n", time.Now().Format("15:04:05"), err)
	} else {
		logPrintf("[%s] 三分位数据已保存: Q1=%d, Q2=%d, Q3=%d (基于最近%d个数据点)\n",
			time.Now().Format("15:04:05"), q1, q2, q3, len(fees))
	}
}
