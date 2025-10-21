import { 
  Connection, 
  PublicKey, 
  Keypair, 
  VersionedTransaction,
  clusterApiUrl
} from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import BN from 'bn.js';
import axios from 'axios';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import CryptoJS from 'crypto-js';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 获取北京时间字符串，例如 2025-10-20 18:09:01
function beijingNow(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// 全局日志前缀注入：[YYYY-MM-DD HH:mm:ss][removeLiquidity]
(function setupPrefixedLogger() {
  const FILE_TAG = 'removeLiquidity';
  const prefix = () => `[${beijingNow()}][${FILE_TAG}]`;
  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origDebug = (console as any).debug ? (console as any).debug.bind(console) : origLog;
  console.log = (...args: any[]) => origLog(prefix(), ...args);
  console.info = (...args: any[]) => origInfo(prefix(), ...args);
  console.warn = (...args: any[]) => origWarn(prefix(), ...args);
  console.error = (...args: any[]) => origError(prefix(), ...args);
  // @ts-ignore 兼容环境无 debug 的情况
  console.debug = (...args: any[]) => origDebug(prefix(), ...args);
})();

// 加载环境变量
dotenv.config();

/**
 * 检查jupSwap是否执行成功
 * @param stdout 标准输出
 * @param stderr 标准错误输出
 * @returns 是否执行成功
 */
function checkJupSwapSuccess(stdout: string, stderr: string): boolean {
  const output = (stdout + ' ' + stderr).toLowerCase();
  
  // 1. 检查是否有致命错误
  const fatalErrors = [
    'error',
    'failed',
    'exception',
    'timeout',
    'insufficient',
    'rejected',
    'invalid',
    'unauthorized',
    'http 4',
    'http 5'
  ];
  
  // 检查是否包含致命错误关键词
  for (const error of fatalErrors) {
    if (output.includes(error)) {
      console.log(`❌ 检测到错误关键词: ${error}`);
      return false;
    }
  }
  
  // 2. 检查jupSwap特定的成功指标（基于实际输出格式）
  const jupSwapSuccessIndicators = [
    '"status":"success"',           // JSON中的status字段
    '"code":0',                     // JSON中的code字段为0
    'swap successful:',             // 成功提示文本
    'signature":',                  // 包含交易签名
    'solscan.io/tx/',              // 包含Solscan链接
    'totalinputamount',             // 包含输入金额
    'totaloutputamount',            // 包含输出金额
    'swapevents'                    // 包含交换事件
  ];
  
  // 检查是否包含jupSwap成功指标
  for (const indicator of jupSwapSuccessIndicators) {
    if (output.includes(indicator)) {
      console.log(`✅ 检测到jupSwap成功指标: ${indicator}`);
      return true;
    }
  }
  
  // 3. 检查HTTP状态码
  if (output.includes('http 200')) {
    console.log('✅ 检测到HTTP 200状态码');
    return true;
  }
  
  // 4. 检查JSON格式的成功响应
  try {
    // 尝试解析JSON输出
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0];
      const jsonData = JSON.parse(jsonStr);
      
      // 检查关键字段
      if (jsonData.status === 'Success' || jsonData.code === 0) {
        console.log('✅ 检测到JSON格式的成功响应');
        return true;
      }
      
      if (jsonData.signature && jsonData.swapEvents) {
        console.log('✅ 检测到完整的交换响应（包含签名和事件）');
        return true;
      }
    }
  } catch (e) {
    // JSON解析失败，继续其他检查
  }
  
  // 5. 检查stderr是否为空或只包含警告信息
  if (stderr.trim() === '') {
    console.log('✅ stderr为空，认为执行成功');
    return true;
  }
  
  // 6. 检查stderr是否只包含警告（非错误）
  const warningKeywords = ['warning', 'warn', 'notice', 'info'];
  const stderrLower = stderr.toLowerCase();
  const hasOnlyWarnings = warningKeywords.some(keyword => stderrLower.includes(keyword)) && 
                         !fatalErrors.some(error => stderrLower.includes(error));
  
  if (hasOnlyWarnings) {
    console.log('✅ stderr只包含警告信息，认为执行成功');
    return true;
  }
  
  // 7. 默认情况：如果有stdout输出且没有明显错误，认为成功
  if (stdout.trim() !== '' && !fatalErrors.some(error => output.includes(error))) {
    console.log('✅ 有stdout输出且无致命错误，认为执行成功');
    return true;
  }
  
  console.log('❌ 无法确定执行状态，默认认为失败');
  return false;
}

/**
 * 重试机制
 */
async function withRetry<T>(fn: () => Promise<T>, operation: string): Promise<T> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`${operation} 第 ${i + 1} 次尝试失败:`, lastError.message);
      
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // 指数退避
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * 检查代币余额 - 使用 OKX API
 * @param tokenMint 代币合约地址
 * @returns 代币余额
 */
async function checkTokenBalance(tokenMint: string): Promise<number> {
  try {
    const userWallet = process.env.USER_WALLET_ADDRESS;
    if (!userWallet) {
      console.error('缺少用户钱包地址：请在 .env 中设置 USER_WALLET_ADDRESS');
      return 0;
    }

    const apiKey = process.env.OKX_API_KEY_XcqG;
    const secretKey = process.env.OKX_SECRET_KEY_XcqG;
    const passphrase = process.env.OKX_PASSPHRASE_XcqG;

    if (!apiKey || !secretKey || !passphrase) {
      console.error('缺少 OKX API 凭证：请在 .env 中设置 OKX_API_KEY_XcqG、OKX_SECRET_KEY_XcqG、OKX_PASSPHRASE_XcqG');
      return 0;
    }

    const timestamp = new Date().toISOString();
    const method = 'POST';
    const requestPath = '/api/v6/dex/balance/token-balances-by-address';
    const bodyArray = {
      address: userWallet,
      tokenContractAddresses: [
        {
          chainIndex: '501',
          tokenContractAddress: tokenMint === 'So11111111111111111111111111111111111111112' ? '' : tokenMint
        }
      ]
    };
    const bodyString = JSON.stringify(bodyArray);

    const prehash = `${timestamp}${method}${requestPath}${bodyString}`;
    const signature = CryptoJS.enc.Base64.stringify(
      CryptoJS.HmacSHA256(prehash, secretKey)
    );

    const url = `https://web3.okx.com${requestPath}`;
    const headers = {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-SIGN': signature
    } as const;

    const resp = await withRetry(() => axios.post(url, bodyArray, { headers }), 'OKX 代币余额');
    
    if (!resp?.data) {
      console.log('OKX 余额响应为空');
      return 0;
    }
    
    if (resp.data.code !== '0') {
      console.log(`OKX 返回错误: code=${resp.data.code}, msg=${resp.data.msg || ''}`);
      return 0;
    }

    const data = resp.data.data;
    if (!Array.isArray(data) || data.length === 0) {
      console.log('OKX 响应中未找到余额数据');
      return 0;
    }

    const tokenAssets = data[0]?.tokenAssets;
    if (!Array.isArray(tokenAssets) || tokenAssets.length === 0) {
      console.log('OKX 响应中未找到代币资产');
      return 0;
    }

    const tokenAsset = tokenAssets.find((asset: any) => {
      // 如果是 SOL 主链币，匹配空字符串或 SOL 符号
      if (tokenMint === 'So11111111111111111111111111111111111111112') {
        return asset.tokenContractAddress === '' || asset.symbol === 'SOL';
      }
      // 其他代币按合约地址匹配
      return asset.tokenContractAddress === tokenMint;
    });

    if (!tokenAsset) {
      console.log(`未找到代币 ${tokenMint} 的余额信息`);
      return 0;
    }

    const balance = parseFloat(tokenAsset.balance || '0');
    console.log(`✅ OKX API 获取到代币 ${tokenMint} 余额: ${balance}`);
    
    return balance;
  } catch (error) {
    console.error('检查代币余额失败:', error);
    return 0;
  }
}

/**
 * 智能等待代币到账并执行 jupSwap
 * @param ca token合约地址
 */
async function waitForTokenAndExecuteJupSwap(ca: string): Promise<void> {
  const maxWaitTime = 10000; // 最多等待10秒
  const checkInterval = 1000; // 每1秒检查一次
  const startTime = Date.now();
  
  console.log(`🔍 开始检查代币余额: ${ca}`);
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      // 检查代币余额
      const balance = await checkTokenBalance(ca);
      if (balance > 0) {
        console.log(`✅ 检测到代币余额: ${balance}，立即执行 jupSwap`);
        await executeJupSwap(ca);
        return;
      }
      
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`⏳ 代币余额为0，已等待 ${elapsed} 秒，继续检查...`);
      
      // 等待下次检查
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
    } catch (error) {
      console.error('❌ 检查代币余额失败:', error instanceof Error ? error.message : String(error));
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }
  
  console.log(`⏰ 等待超时(10秒)，强制执行 jupSwap`);
  await executeJupSwap(ca);
}

/**
 * 执行 jupSwap 命令
 * @param ca token合约地址
 * @returns 是否执行成功
 */
async function executeJupSwap(ca: string): Promise<boolean> {
  try {
    console.log(`🔄 开始执行 jupSwap: ${ca}`);
    
    const command = `./jupSwap -input ${ca} -maxfee 500000`;
    console.log(`执行命令: ${command}`);
    
    const { stdout, stderr } = await execAsync(command, {
      cwd: '/Users/yqw/meteora_dlmm'
    });
    
    if (stdout) {
      console.log('jupSwap 输出:', stdout);
    }
    if (stderr) {
      console.error('jupSwap 错误:', stderr);
    }
    
    // 更准确的成功判断逻辑
    const isSuccess = checkJupSwapSuccess(stdout, stderr);
    if (isSuccess) {
      console.log('✅ jupSwap 执行成功');
      return true;
    } else {
      console.log('❌ jupSwap 执行失败');
      return false;
    }
  } catch (error) {
    console.error('❌ jupSwap 执行失败:', error);
    return false;
  }
}

/**
 * 从JSON文件读取token合约地址
 * @param poolAddress 池地址
 * @returns token合约地址
 */
function readTokenContractAddressFromPoolJson(poolAddress: string): string | undefined {
  try {
    const file = path.resolve(__dirname, 'data', `${poolAddress}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    
    // 优先从顶层ca字段读取
    if (json.ca) {
      return json.ca;
    }
    
    // 其次从data.ca字段读取
    if (json.data && json.data.ca) {
      return json.data.ca;
    }
    
    return undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * 移动JSON文件到history目录
 * @param poolAddress 池地址
 */
async function moveJsonToHistory(poolAddress: string): Promise<void> {
  try {
    // 确保history目录存在
    const historyDir = path.resolve(__dirname, 'data', 'history');
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
      console.log('📁 创建history目录:', historyDir);
    }
    
    // 源文件路径
    const sourceFile = path.resolve(__dirname, 'data', `${poolAddress}.json`);
    // 目标文件路径（添加时间戳避免重名）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetFile = path.resolve(historyDir, `${poolAddress}_${timestamp}.json`);
    
    // 检查源文件是否存在
    if (!fs.existsSync(sourceFile)) {
      console.log('⚠️ 源JSON文件不存在:', sourceFile);
      return;
    }
    
    // 移动文件
    fs.renameSync(sourceFile, targetFile);
    console.log('📦 JSON文件已移动到history目录:');
    console.log(`   源文件: ${sourceFile}`);
    console.log(`   目标文件: ${targetFile}`);
    
  } catch (error) {
    console.error('❌ 移动JSON文件到history失败:', error);
  }
}

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

// 从命令行参数中获取是否跳过swap
function getSkipSwapFromArgs(): boolean {
  for (const arg of argv) {
    if (arg === '--skipSwap' || arg === '--skipSwap=true') return true;
    if (arg === '--skipSwap=false') return false;
  }
  return false;
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
    let transactions;
    try {
      transactions = await withRetry(() => dlmmPool.removeLiquidity({
        user: new PublicKey(process.env.USER_WALLET_ADDRESS!),  // 用户公钥 (从.env读取)
        position: positionPubKey,              // 仓位公钥
        fromBinId: lowerBinId,                 // 下限bin ID
        toBinId: upperBinId,                   // 上限bin ID
        bps: new BN(10000),                    // 移除100%流动性 (10000 BPS = 100%) - 默认移除所有流动性
        shouldClaimAndClose: true,             // 领取奖励并关闭仓位 - 默认true
        skipUnwrapSOL: false                   // 不解包SOL - 默认false
      }), 'dlmmPool.removeLiquidity');
    } catch (error) {
      // 如果没有流动性可移除，尝试直接关闭仓位
      if (error instanceof Error && (error.message.includes('No liquidity to remove') || error.message.includes('Cannot read properties of null'))) {
        console.log('⚠️ 仓位中没有流动性或仓位数据为空，尝试直接关闭仓位...');
        try {
          // 获取仓位对象
          const position = await withRetry(() => dlmmPool.getPosition(positionPubKey), 'dlmmPool.getPosition');
          
          // 使用 closePositionIfEmpty 方法关闭空仓位
          const closeTransaction = await withRetry(() => dlmmPool.closePositionIfEmpty({
            owner: new PublicKey(process.env.USER_WALLET_ADDRESS!),
            position: position
          }), 'dlmmPool.closePositionIfEmpty');
          
          transactions = [closeTransaction];
          console.log('✅ 成功生成关闭空仓位交易');
        } catch (closeError) {
          console.log('❌ 关闭仓位也失败:', closeError instanceof Error ? closeError.message : String(closeError));
          // 如果关闭也失败，可能是仓位已经被关闭或不存在
          if (closeError instanceof Error && closeError.message.includes('Cannot read properties of null')) {
            console.log('ℹ️ 仓位可能已经被关闭或不存在，无需进一步操作');
            return; // 直接返回，不抛出错误
          }
          throw closeError;
        }
      } else {
        throw error;
      }
    }
    
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
    
    // 可通过 --skipSwap 控制是否在移除后立即执行 jupSwap（默认执行）
    const skipSwap = getSkipSwapFromArgs();

    if (skipSwap) {
      console.log('⏭️ 检测到 --skipSwap，跳过移除后的 jupSwap');
    } else {
      const ca = readTokenContractAddressFromPoolJson(finalPoolAddress);
      if (ca) {
        console.log(`🔄 移除流动性成功，开始智能等待代币到账并执行 jupSwap: ${ca}`);
        await waitForTokenAndExecuteJupSwap(ca);
      } else {
        console.log('⚠️ 未找到 token 合约地址，跳过 jupSwap');
      }
    }

    await moveJsonToHistory(finalPoolAddress);
    
  } catch (error) {
    console.error('错误:', error);
  }
}

// 运行
if (require.main === module) {
  removeLiquidity();
}