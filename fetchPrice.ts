import { 
  Connection, 
  PublicKey, 
  clusterApiUrl
} from '@solana/web3.js';
import * as dotenv from 'dotenv';
import * as CryptoJS from 'crypto-js';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// 加载环境变量
dotenv.config();

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 从命令行读取参数
const argv = process.argv.slice(2);
function resolvePoolAddressFromArgs(): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--pool=')) return sanitizeString(arg.split('=')[1]);
  }
  return undefined;
}

function resolveTokenAddressFromArgs(): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--token-address=')) return sanitizeString(arg.split('=')[1]);
    if (arg.startsWith('--token=')) return sanitizeString(arg.split('=')[1]);
  }
  return undefined;
}

// 通用的引号处理函数
function sanitizeString(input: string): string {
  let s = input.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\'')) || (s.startsWith('`') && s.endsWith('`'))) {
    s = s.slice(1, -1);
  }
  if (s.endsWith('\\"') || s.endsWith('\\\'')) {
    s = s.slice(0, -2);
  }
  s = s.replace(/%20/g, ' ');
  return s.trim();
}

// 通用重试工具
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
 * 从 JSON 文件中读取 c 字段和 positionAddress
 */
async function readPoolDataFromJSON(poolAddress: string): Promise<{c: number, positionAddress: string} | null> {
  try {
    const dataPath = path.join('/Users/yqw/meteora_dlmm/data', `${poolAddress}.json`);
    
    if (!fs.existsSync(dataPath)) {
      console.log(`JSON 文件不存在: ${dataPath}`);
      return null;
    }
    
    const jsonData = await fs.promises.readFile(dataPath, 'utf-8');
    const data = JSON.parse(jsonData);
    
    // 优先从顶层读取 c 和 positionAddress
    let c = data.c;
    let positionAddress = data.positionAddress;
    
    // 如果顶层没有，从 data 字段读取
    if (c === undefined && data.data && data.data.c !== undefined) {
      c = data.data.c;
    }
    if (!positionAddress && data.data && data.data.positionAddress) {
      positionAddress = data.data.positionAddress;
    }
    
    if (c === undefined || !positionAddress) {
      console.log(`JSON 文件中缺少必要字段: c=${c}, positionAddress=${positionAddress}`);
      return null;
    }
    
    return {
      c: parseFloat(c),
      positionAddress: positionAddress
    };
  } catch (error) {
    console.error(`读取 JSON 文件失败: ${error}`);
    return null;
  }
}

/**
 * 执行移除流动性操作
 */
async function executeRemoveLiquidity(poolAddress: string, positionAddress: string): Promise<void> {
  try {
    console.log(`🚨 价格低于阈值，开始移除流动性...`);
    console.log(`池地址: ${poolAddress}`);
    console.log(`仓位地址: ${positionAddress}`);
    
    const command = `npx ts-node removeLiquidity.ts --pool=${poolAddress} --position=${positionAddress}`;
    console.log(`执行命令: ${command}`);
    
    const { stdout, stderr } = await execAsync(command, {
      cwd: '/Users/yqw/meteora_dlmm'
    });
    
    if (stdout) {
      console.log('移除流动性输出:', stdout);
    }
    if (stderr) {
      console.error('移除流动性错误:', stderr);
    }
    
    console.log('✅ 移除流动性操作完成');
  } catch (error) {
    console.error('❌ 移除流动性操作失败:', error);
  }
}

/**
 * 获取 OKX DEX 最新价格（需要鉴权）
 * POST /api/v5/dex/market/price
 * headers: OK-ACCESS-KEY, OK-ACCESS-PASSPHRASE, OK-ACCESS-TIMESTAMP, OK-ACCESS-SIGN
 */
async function fetchOkxLatestPrice(tokenContractAddress: string): Promise<string | undefined> {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error('缺少 OKX API 凭证：请在 .env 中设置 OKX_API_KEY、OKX_SECRET_KEY、OKX_PASSPHRASE');
  }

  const timestamp = new Date().toISOString();
  const method = 'POST';
  const requestPath = '/api/v5/dex/market/price';
  const bodyArray = [
    {
      chainIndex: '501',
      tokenContractAddress
    }
  ];
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

  const resp = await withRetry(() => axios.post(url, bodyArray, { headers }), 'OKX 最新价格');
  if (!resp?.data) {
    console.log('OKX 价格响应为空');
    return undefined;
  }
  if (resp.data.code !== '0') {
    console.log(`OKX 返回错误: code=${resp.data.code}, msg=${resp.data.msg || ''}`);
    return undefined;
  }
  const rows = Array.isArray(resp.data.data) ? resp.data.data : [];
  const wantAddr = tokenContractAddress;
  const entry = rows.find((r: any) => r?.chainIndex === '501' && String(r?.tokenContractAddress) === String(wantAddr)) || rows[0];
  if (!entry?.price) {
    console.log('OKX 响应中未找到价格字段，原始响应:', JSON.stringify(resp.data));
    return undefined;
  }
  return String(entry.price);
}

/**
 * 主函数 - 获取价格并进行比较
 */
async function main() {
  try {
    // 解析参数
    const poolAddress = resolvePoolAddressFromArgs();
    const tokenAddress = resolveTokenAddressFromArgs();
    
    if (!poolAddress) {
      throw new Error('缺少必需的POOL_ADDRESS，请通过 --pool= 传入');
    }
    
    if (!tokenAddress) {
      throw new Error('缺少必需的TOKEN_ADDRESS，请通过 --token= 传入');
    }
    
    console.log(`使用的POOL_ADDRESS: ${poolAddress}`);
    console.log(`使用的TOKEN_ADDRESS: ${tokenAddress}`);
    
    // 获取最新价格
    console.log('🔄 正在获取OKX最新价格...');
    const latestPrice = await fetchOkxLatestPrice(tokenAddress);
    if (latestPrice !== undefined) {
      console.log('OKX DEX 最新价格:', latestPrice);
      console.log('price:', latestPrice); // 专门输出price字段，供main.go解析
      
      // 读取池数据进行比较
      const poolData = await readPoolDataFromJSON(poolAddress);
      if (poolData) {
        const currentPrice = parseFloat(latestPrice);
        const threshold = poolData.c * 0.4;
        
        console.log(`📊 价格比较:`);
        console.log(`  当前价格: ${currentPrice}`);
        console.log(`  阈值 (c * 0.4): ${threshold}`);
        console.log(`  c 值: ${poolData.c}`);
        
        if (currentPrice < threshold) {
          console.log(`⚠️  当前价格 ${currentPrice} 低于阈值 ${threshold}，触发移除流动性操作`);
          await executeRemoveLiquidity(poolAddress, poolData.positionAddress);
        } else {
          console.log(`✅ 当前价格 ${currentPrice} 高于阈值 ${threshold}，无需操作`);
        }
      } else {
        console.log('⚠️  无法读取池数据，跳过价格比较');
      }
    } else {
      console.log('未获取到 OKX 最新价格');
    }
    
  } catch (error) {
    console.error('错误:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，则执行main函数
if (require.main === module) {
  main();
}
