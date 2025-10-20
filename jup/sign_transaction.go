package main

import (
	"encoding/base64"
	"fmt"
	"log"
	"os"

	"github.com/gagliardetto/solana-go"
	"github.com/joho/godotenv"
	"github.com/mr-tron/base58"
)

func mustLoadPrivateKey() solana.PrivateKey {
	_ = godotenv.Load("swap.env")

	// 首先尝试获取加密的私钥
	encryptedPrivateKey := os.Getenv("ENCRYPTED_PRIVATE_KEY")
	if encryptedPrivateKey != "" {
		// 使用加密的私钥
		priv, err := GetEncryptedPrivateKey()
		if err != nil {
			log.Fatalf("解密私钥失败: %v", err)
		}

		// 解析解密后的私钥
		pk, err := solana.PrivateKeyFromBase58(priv)
		if err == nil {
			return pk
		}
		// 或者存的是 web3.js 风格的base58解码后的原始字节再编码，这里兜底解析
		raw, derr := base58.Decode(priv)
		if derr != nil {
			log.Fatalf("解密后的PRIVATE_KEY解析失败: %v / %v", err, derr)
		}
		return solana.PrivateKey(raw)
	}

	// 如果没有加密的私钥，尝试获取明文私钥（向后兼容）
	priv := os.Getenv("PRIVATE_KEY")
	if priv == "" {
		log.Fatal("未找到 PRIVATE_KEY 或 ENCRYPTED_PRIVATE_KEY，请在 swap.env 中设置 base58 私钥或使用加密私钥")
	}

	// 支持 swap.env 里直接存 base58 字符串
	pk, err := solana.PrivateKeyFromBase58(priv)
	if err == nil {
		return pk
	}
	// 或者存的是 web3.js 风格的base58解码后的原始字节再编码，这里兜底解析
	raw, derr := base58.Decode(priv)
	if derr != nil {
		log.Fatalf("PRIVATE_KEY 解析失败: %v / %v", err, derr)
	}
	return solana.PrivateKey(raw)
}

// 解析 Solana shortvec（用于 signatures 数量）
func decodeShortVec(data []byte) (value int, read int, ok bool) {
	var result int
	var shift uint
	for i, b := range data {
		result |= int(b&0x7F) << shift
		read++
		if b&0x80 == 0 {
			return result, read, true
		}
		shift += 7
		if i > 4 { // 合理上限，避免畸形数据
			break
		}
	}
	return 0, 0, false
}

func sign_transaction(inputMint, outputMint, amount string) (string, string, error) {
	// 1) 获取未签名交易与 requestId（来自 order()）
	txBase64, requestId, err := order(inputMint, outputMint, amount)
	if err != nil {
		return "", "", fmt.Errorf("获取订单失败: %w", err)
	}
	if txBase64 == "" {
		return "", "", fmt.Errorf("订单返回 transaction 为空，可能是余额不足或路由不可用")
	}

	// 2) 解码为原始 tx 字节（wire 格式：shortvec(sig_count) + sigs + message）
	rawTx, err := base64.StdEncoding.DecodeString(txBase64)
	if err != nil {
		return "", "", fmt.Errorf("交易 base64 解码失败: %w", err)
	}
	if len(rawTx) < 1 {
		return "", "", fmt.Errorf("交易字节长度异常")
	}

	sigCount, prefixLen, ok := decodeShortVec(rawTx)
	if !ok || sigCount <= 0 {
		return "", "", fmt.Errorf("无法解析签名数量: sigCount=%d prefixLen=%d", sigCount, prefixLen)
	}
	need := prefixLen + sigCount*64
	if len(rawTx) < need {
		return "", "", fmt.Errorf("交易字节长度不足: len=%d need>=%d", len(rawTx), need)
	}
	message := rawTx[need:]

	// 3) 对 message 进行签名
	priv := mustLoadPrivateKey()
	sig, err := priv.Sign(message)
	if err != nil {
		return "", "", fmt.Errorf("签名失败: %w", err)
	}

	// 4) 将签名写回第一个签名槽位
	copy(rawTx[prefixLen:prefixLen+64], sig[:])

	// 5) 输出最终序列化后的交易
	signedBase64 := base64.StdEncoding.EncodeToString(rawTx)
	fmt.Printf("signedTransaction(base64)=%s\n", signedBase64)
	return signedBase64, requestId, nil
}
