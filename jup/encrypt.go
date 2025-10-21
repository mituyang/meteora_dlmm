package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"os"

	"github.com/joho/godotenv"
)

// EncryptPrivateKey 使用AES-256-GCM加密私钥
func EncryptPrivateKey(privateKey, password string) (string, error) {
	// 从密码生成32字节密钥
	key := sha256.Sum256([]byte(password))

	// 创建AES cipher
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("创建AES cipher失败: %w", err)
	}

	// 创建GCM模式
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("创建GCM模式失败: %w", err)
	}

	// 生成随机nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("生成nonce失败: %w", err)
	}

	// 加密数据
	ciphertext := gcm.Seal(nonce, nonce, []byte(privateKey), nil)

	// 返回base64编码的结果
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// DecryptPrivateKey 解密私钥
func DecryptPrivateKey(encryptedPrivateKey, password string) (string, error) {
	// 从密码生成32字节密钥
	key := sha256.Sum256([]byte(password))

	// 解码base64
	data, err := base64.StdEncoding.DecodeString(encryptedPrivateKey)
	if err != nil {
		return "", fmt.Errorf("base64解码失败: %w", err)
	}

	// 创建AES cipher
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("创建AES cipher失败: %w", err)
	}

	// 创建GCM模式
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("创建GCM模式失败: %w", err)
	}

	// 检查数据长度
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("加密数据长度不足")
	}

	// 分离nonce和密文
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]

	// 解密
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("解密失败: %w", err)
	}

	return string(plaintext), nil
}

// GetEncryptedPrivateKey 从环境变量获取并解密私钥
func GetEncryptedPrivateKey() (string, error) {
	// 加载swap.env文件
	_ = godotenv.Load("swap.env")

	// 获取加密的私钥
	encryptedPrivateKey := os.Getenv("ENCRYPTED_PRIVATE_KEY")
	if encryptedPrivateKey == "" {
		return "", fmt.Errorf("未找到ENCRYPTED_PRIVATE_KEY环境变量")
	}

	// 获取加密密钥
	encryptionKey := os.Getenv("ENCRYPTION_KEY")
	if encryptionKey == "" {
		return "", fmt.Errorf("未找到ENCRYPTION_KEY环境变量")
	}

	// 解密私钥
	privateKey, err := DecryptPrivateKey(encryptedPrivateKey, encryptionKey)
	if err != nil {
		return "", fmt.Errorf("解密私钥失败: %w", err)
	}

	return privateKey, nil
}

// EncryptPrivateKeyOnly 仅加密私钥，不保存到文件
func EncryptPrivateKeyOnly(privateKey, password string) (string, error) {
	// 加密私钥
	encryptedPrivateKey, err := EncryptPrivateKey(privateKey, password)
	if err != nil {
		return "", fmt.Errorf("加密私钥失败: %w", err)
	}

	return encryptedPrivateKey, nil
}

// 命令行工具函数
func encryptPrivateKeyCLI() {
	encryptLogger.Log("=== PRIVATE_KEY 加密工具 ===")

	// 获取私钥
	var privateKey string
	fmt.Print("请输入您的base58私钥: ")
	fmt.Scanln(&privateKey)

	if privateKey == "" {
		encryptLogger.Error("私钥不能为空")
		return
	}

	// 获取加密密码
	var password string
	fmt.Print("请输入加密密码: ")
	fmt.Scanln(&password)

	if password == "" {
		encryptLogger.Error("加密密码不能为空")
		return
	}

	// 确认密码
	var confirmPassword string
	fmt.Print("请再次输入加密密码: ")
	fmt.Scanln(&confirmPassword)

	if password != confirmPassword {
		encryptLogger.Error("两次输入的密码不一致")
		return
	}

	// 仅加密私钥
	encryptedPrivateKey, err := EncryptPrivateKeyOnly(privateKey, password)
	if err != nil {
		encryptLogger.Error("加密失败: %v", err)
		return
	}

	encryptLogger.Log("\n=== 加密结果 ===")
	encryptLogger.Log("加密后的私钥: %s", encryptedPrivateKey)
	encryptLogger.Log("加密密钥: %s", password)
	encryptLogger.Log("\n请手动将以下内容添加到您的swap.env文件中:")
	encryptLogger.Log("ENCRYPTED_PRIVATE_KEY=%s", encryptedPrivateKey)
	encryptLogger.Log("ENCRYPTION_KEY=%s", password)
	encryptLogger.Log("\n注意：请妥善保管您的加密密钥，丢失后将无法恢复私钥")
}
