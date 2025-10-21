package main

import (
	"fmt"
	"log"
	"os"
	"time"
)

// Logger 日志记录器结构
type Logger struct {
	fileTag string
}

// NewLogger 创建新的日志记录器
func NewLogger(fileTag string) *Logger {
	return &Logger{fileTag: fileTag}
}

// beijingNow 获取北京时间字符串，例如 2025-10-20 18:09:01
func (l *Logger) beijingNow() string {
	now := time.Now()
	// 使用北京时间 (UTC+8)
	beijing := now.In(time.FixedZone("CST", 8*60*60))
	return beijing.Format("2006-01-02 15:04:05")
}

// prefix 生成日志前缀
func (l *Logger) prefix() string {
	return fmt.Sprintf("[%s][%s]", l.beijingNow(), l.fileTag)
}

// Log 记录普通日志
func (l *Logger) Log(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("%s %s\n", l.prefix(), message)
}

// Info 记录信息日志
func (l *Logger) Info(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("%s %s\n", l.prefix(), message)
}

// Warn 记录警告日志
func (l *Logger) Warn(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("%s WARN: %s\n", l.prefix(), message)
}

// Error 记录错误日志
func (l *Logger) Error(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("%s ERROR: %s\n", l.prefix(), message)
}

// Debug 记录调试日志
func (l *Logger) Debug(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("%s DEBUG: %s\n", l.prefix(), message)
}

// Fatal 记录致命错误并退出程序
func (l *Logger) Fatal(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("%s FATAL: %s\n", l.prefix(), message)
	os.Exit(1)
}

// Printf 兼容标准库的Printf接口
func (l *Logger) Printf(format string, args ...interface{}) {
	l.Log(format, args...)
}

// Print 兼容标准库的Print接口
func (l *Logger) Print(args ...interface{}) {
	message := fmt.Sprint(args...)
	fmt.Printf("%s %s\n", l.prefix(), message)
}

// Println 兼容标准库的Println接口
func (l *Logger) Println(args ...interface{}) {
	message := fmt.Sprintln(args...)
	fmt.Printf("%s %s", l.prefix(), message)
}

// 全局日志记录器实例
var (
	mainLogger            *Logger
	executeOrderLogger    *Logger
	encryptLogger         *Logger
	signTransactionLogger *Logger
	getOrderLogger        *Logger
	getHoldingsLogger     *Logger
)

// init 初始化全局日志记录器
func init() {
	mainLogger = NewLogger("main")
	executeOrderLogger = NewLogger("execute_order")
	encryptLogger = NewLogger("encrypt")
	signTransactionLogger = NewLogger("sign_transaction")
	getOrderLogger = NewLogger("get_order")
	getHoldingsLogger = NewLogger("get_holdings")
}

// 全局日志函数，使用mainLogger
func Log(format string, args ...interface{}) {
	mainLogger.Log(format, args...)
}

func Info(format string, args ...interface{}) {
	mainLogger.Info(format, args...)
}

func Warn(format string, args ...interface{}) {
	mainLogger.Warn(format, args...)
}

func Error(format string, args ...interface{}) {
	mainLogger.Error(format, args...)
}

func Debug(format string, args ...interface{}) {
	mainLogger.Debug(format, args...)
}

func Fatal(format string, args ...interface{}) {
	mainLogger.Fatal(format, args...)
}

// 替换标准log包的行为
func initLogging() {
	// 替换标准log包的输出
	log.SetFlags(0) // 移除默认的时间戳和文件信息
	log.SetOutput(&logWriter{logger: mainLogger})
}

// logWriter 实现io.Writer接口，用于替换标准log包的输出
type logWriter struct {
	logger *Logger
}

func (w *logWriter) Write(p []byte) (n int, err error) {
	message := string(p)
	// 移除末尾的换行符（log包会自动添加）
	if len(message) > 0 && message[len(message)-1] == '\n' {
		message = message[:len(message)-1]
	}
	w.logger.Log("%s", message)
	return len(p), nil
}
