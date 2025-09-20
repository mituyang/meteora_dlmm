import { 
  Connection, 
  PublicKey, 
  Keypair, 
  VersionedTransaction,
  clusterApiUrl
} from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import BN from 'bn.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import CryptoJS from 'crypto-js';

// 加载环境变量
dotenv.config();

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 命令行参数解析
const argv = process.argv.slice(2);

// 清理字符串，移除引号和多余空格
function sanitizeString(str: string): string {
  return str.replace(/['"]/g, '').trim();
}

// 从命令行参数中获取池地址
function getPoolFromArgs(): string | null {
  for (const arg of argv) {
    if (arg.startsWith('--pool=')) return sanitizeString(arg.split('=')[1]);
  }
  return null;
}

// 从命令行参数中获取仓位地址
function getPositionFromArgs(): string | null {
  for (const arg of argv) {
    if (arg.startsWith('--position=')) return sanitizeString(arg.split('=')[1]);
  }
  return null;
}

/**
 * 解密私钥
 * @param encryptedPrivateKey 加密的私钥
 * @param password 解密密码
 * @returns 解密后的私钥字符串
 */
function decryptPrivateKey(encryptedPrivateKey: string, password: string): string {
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedPrivateKey, password);
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    throw new Error('私钥解密失败，请检查密码是否正确');
  }
}

// 通用重试：失败等1秒再试，最多2次（总尝试3次）
async function withRetry<T>(fn: () => Promise<T>, desc: string): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.log(`获取失败，1秒后重试(${attempt}/${maxAttempts - 1}) -> ${desc}:`, err instanceof Error ? err.message : String(err));
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 验证Solana地址格式
 * @param address 地址字符串
 * @param name 地址名称（用于错误信息）
 */
function validateSolanaAddress(address: string, name: string): void {
  try {
    new PublicKey(address);
  } catch (error) {
    throw new Error(`${name}格式无效: ${address}`);
  }
}

/**
 * 移除流动性的基本用法
 */
async function removeLiquidity() {
  try {
    // 1. 获取池地址（命令行参数 > 环境变量）
    const finalPoolAddress = getPoolFromArgs() || process.env.POOL_ADDRESS;
    if (!finalPoolAddress) {
      throw new Error('缺少必需的池地址：请通过 --pool= 传入，或在环境变量中设置 POOL_ADDRESS');
    }
    
    // 验证池地址格式
    validateSolanaAddress(finalPoolAddress, '池地址');
    const poolPubKey = new PublicKey(finalPoolAddress);
    const dlmmPool = await withRetry(() => DLMM.create(connection, poolPubKey), 'DLMM.create');
    
    // 2. 获取仓位地址（命令行参数 > 环境变量）
    const finalPositionAddress = getPositionFromArgs() || process.env.POSITION_ADDRESS;
    if (!finalPositionAddress) {
      throw new Error('缺少必需的仓位地址：请通过 --position= 传入，或在环境变量中设置 POSITION_ADDRESS');
    }
    
    // 验证仓位地址格式
    validateSolanaAddress(finalPositionAddress, '仓位地址');
    const positionPubKey = new PublicKey(finalPositionAddress);
    
    // 3. 创建用户密钥对
    let userKeypair: Keypair;
    
    // 检查是否使用加密私钥
    if (process.env.PRIVATE_KEY_ENCRYPTED === 'true') {
      if (!process.env.PRIVATE_KEY_PASSWORD) {
        throw new Error('使用加密私钥时，必须设置PRIVATE_KEY_PASSWORD环境变量');
      }
      try {
        const decryptedPrivateKey = decryptPrivateKey(process.env.PRIVATE_KEY!, process.env.PRIVATE_KEY_PASSWORD);
        userKeypair = Keypair.fromSecretKey(bs58.decode(decryptedPrivateKey));
        console.log('✅ 从环境变量加载钱包 (加密私钥)');
      } catch (decryptError) {
        console.log('❌ 私钥解密失败');
        throw new Error('私钥解密失败，请检查PRIVATE_KEY_PASSWORD是否正确');
      }
    } else {
      // 使用明文私钥
      userKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
      console.log('✅ 从环境变量加载钱包 (明文私钥)');
    }
    
    // 4. Bin范围设置
    const lowerBinId = -443636;  // 负无穷大 (Meteora DLMM 最小bin ID)
    const upperBinId = 443636;   // 正无穷大 (Meteora DLMM 最大bin ID)
    
    console.log('=== 移除流动性 ===');
    console.log('用户地址:', process.env.USER_WALLET_ADDRESS);
    console.log('仓位地址:', positionPubKey.toString());
    console.log('池地址:', poolPubKey.toString());
    console.log('Bin范围:', `${lowerBinId} - ${upperBinId}`);
    
    // 5. 调用removeLiquidity方法 - 默认移除所有流动性
    const transactions = await withRetry(() => dlmmPool.removeLiquidity({
      user: new PublicKey(process.env.USER_WALLET_ADDRESS!),  // 用户公钥 (从.env读取)
      position: positionPubKey,              // 仓位公钥
      fromBinId: lowerBinId,                 // 下限bin ID
      toBinId: upperBinId,                   // 上限bin ID
      bps: new BN(10000),                    // 移除100%流动性 (10000 BPS = 100%) - 默认移除所有流动性
      shouldClaimAndClose: true,             // 领取奖励并关闭仓位 - 默认true
      skipUnwrapSOL: false                   // 不解包SOL - 默认false
    }), 'dlmmPool.removeLiquidity');
    
    console.log(`生成了 ${transactions.length} 个交易`);
    
    // 6. 执行交易
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      console.log(`执行交易 ${i + 1}/${transactions.length}...`);
      
      // 签名并发送交易
      transaction.sign(userKeypair as any);
      const versionedTransaction = new VersionedTransaction(transaction.compileMessage());
      versionedTransaction.sign([userKeypair as any]);
      
      const txHash = await withRetry(() => connection.sendTransaction(versionedTransaction), 'connection.sendTransaction');
      console.log(`交易 ${i + 1} 哈希:`, txHash);
      
      // 等待确认
      await withRetry(() => connection.getSignatureStatus(txHash, { searchTransactionHistory: true }), 'connection.getSignatureStatus');
      console.log(`交易 ${i + 1} 已确认`);
    }
    
    console.log('✅ 移除流动性完成');
    
  } catch (error) {
    console.error('错误:', error);
  }
}

// 运行
if (require.main === module) {
  removeLiquidity();
}