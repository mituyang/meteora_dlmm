import { 
  Connection, 
  PublicKey, 
  Keypair, 
  VersionedTransaction,
  clusterApiUrl
} from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import axios from 'axios';
import { fetchOkxLatestPrice as fetchOkxLatestPriceFromModule } from './fetchPrice';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import CryptoJS from 'crypto-js';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 加载环境变量
dotenv.config();

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

// 全局日志前缀注入：[YYYY-MM-DD HH:mm:ss][claimAllRewards]
(function setupPrefixedLogger() {
  const FILE_TAG = 'claimAllRewards';
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

/**
 * 获取 OKX DEX 最新价格（需要鉴权）
 * POST /api/v5/dex/market/price
 * headers: OK-ACCESS-KEY, OK-ACCESS-PASSPHRASE, OK-ACCESS-TIMESTAMP, OK-ACCESS-SIGN
 */
async function fetchOkxLatestPrice(tokenContractAddress: string): Promise<string | undefined> {
  const apiKey = process.env.OKX_API_KEY_xKmQ;
  const secretKey = process.env.OKX_SECRET_KEY_xKmQ;
  const passphrase = process.env.OKX_PASSPHRASE_xKmQ;

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
 * 智能等待代币到账并执行 jupSwap
 * @param ca token合约地址
 */
async function waitForTokenAndExecuteJupSwap(ca: string): Promise<void> {
  const maxWaitTime = 30000; // 最多等待30秒
  const checkInterval = 2000; // 每2秒检查一次
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
  
  console.log(`⏰ 等待超时(30秒)，强制执行 jupSwap`);
  await executeJupSwap(ca);
}

/**
 * 检查代币余额
 * @param tokenMint 代币合约地址
 * @returns 代币余额(最小单位)
 */
async function checkTokenBalance(tokenMint: string): Promise<number> {
  try {
    const userWallet = new PublicKey(process.env.USER_WALLET_ADDRESS!);
    const mintPubKey = new PublicKey(tokenMint);
    
    // 获取代币账户
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userWallet, {
      mint: mintPubKey
    });
    
    if (tokenAccounts.value.length === 0) {
      return 0; // 没有代币账户
    }
    
    // 获取第一个代币账户的余额
    const tokenAccount = tokenAccounts.value[0];
    const balance = tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
    
    return balance || 0;
  } catch (error) {
    console.error('检查代币余额失败:', error);
    return 0;
  }
}

/**
 * 执行 jupSwap 命令
 * @param ca token合约地址
 */
async function executeJupSwap(ca: string): Promise<void> {
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
    
    console.log('✅ jupSwap 执行完成');
  } catch (error) {
    console.error('❌ jupSwap 执行失败:', error);
  }
}

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

function getRawAmount(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  try { return Number(value); } catch { return 0; }
}

// 从本地价格缓存读取 USD 价格：/data/prices/<mint>.json
function readUsdPriceFromCache(tokenMint: string): number | undefined {
  try {
    const p = path.resolve(__dirname, 'data', 'prices', `${tokenMint}.json`);
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    const price = obj?.price;
    if (price === undefined || price === null) return undefined;
    const n = Number(price);
    return Number.isFinite(n) ? n : undefined;
  } catch (_) {
    return undefined;
  }
}

// 命令行参数解析与清洗（优先级高于环境变量）
const argv = process.argv.slice(2);

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

function resolvePoolAddressFromArgs(): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--pool=')) return sanitizeString(arg.split('=')[1]);
  }
  return undefined;
}

function resolvePositionAddressFromArgs(): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--position=')) return sanitizeString(arg.split('=')[1]);
    if (arg.startsWith('--position-address=')) return sanitizeString(arg.split('=')[1]);
  }
  return undefined;
}

function readPositionFromPoolJson(poolAddress: string): string | undefined {
  try {
    const file = path.resolve(__dirname, 'data', `${poolAddress}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    return json.positionAddress || json?.data?.positionAddress;
  } catch (_) {
    return undefined;
  }
}

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
 * 最基本的按仓位领取（Swap Fee + LM 奖励，若有其一即可）
 */
async function claimAllRewardsByPosition() {
  try {
    // 1. 解析池地址与仓位地址（命令行优先，其次环境变量）
    const cliPool = resolvePoolAddressFromArgs();
    const poolAddressStr = cliPool || process.env.POOL_ADDRESS;
    if (!poolAddressStr) {
      throw new Error('缺少必需的池地址：请通过 --pool= 传入，或在环境变量中设置 POOL_ADDRESS');
    }
    const poolAddress = new PublicKey(poolAddressStr);
    const dlmmPool = await withRetry(() => DLMM.create(connection, poolAddress), 'DLMM.create');

    // 2. 加载仓位（LbPosition）
    const cliPosition = resolvePositionAddressFromArgs();
    // 优先级：命令行 > JSON文件(data/<pool>.json) > 环境变量
    const positionFromJson = readPositionFromPoolJson(poolAddress.toString());
    const positionAddressStr = cliPosition || positionFromJson || process.env.POSITION_ADDRESS;
    if (!positionAddressStr) {
      throw new Error('缺少必需的仓位地址：请通过 --position= 或 --position-address= 传入，或在环境变量中设置 POSITION_ADDRESS');
    }
    const positionPubKey = new PublicKey(positionAddressStr);
    const position = await withRetry(() => dlmmPool.getPosition(positionPubKey), 'dlmmPool.getPosition');

    // 3. 获取可领取费用数量和判断是否领取
    console.log('\n=== 检查可领取费用 ===');
    
    // 获取代币精度
    const getTokenDecimals = async (mintAddress: PublicKey): Promise<number> => {
      try {
        console.log(`🔄 正在获取代币精度: ${mintAddress.toString()}`);
        const tokenInfo = await connection.getParsedAccountInfo(mintAddress);
        if (tokenInfo.value?.data && 'parsed' in tokenInfo.value.data) {
          const decimals = tokenInfo.value.data.parsed.info.decimals;
          console.log(`✅ 代币 ${mintAddress.toString()} 精度: ${decimals}`);
          return decimals;
        }
        console.log(`⚠️ 无法解析代币信息，使用默认精度 0: ${mintAddress.toString()}`);
        return 0;
      } catch (error) {
        console.error(`❌ 获取代币精度失败: ${mintAddress.toString()}`, error);
        return 0;
      }
    };

    // 读取 JSON 文件获取池信息
    const readPoolJson = (poolAddress: string): any => {
      try {
        const file = path.resolve(__dirname, 'data', `${poolAddress}.json`);
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    };

    // 获取代币精度
    console.log(`X代币地址: ${dlmmPool.lbPair.tokenXMint.toString()}`);
    console.log(`Y代币地址: ${dlmmPool.lbPair.tokenYMint.toString()}`);
    const tokenXDecimals = await getTokenDecimals(dlmmPool.lbPair.tokenXMint);  // X 精度
    const tokenYDecimals = await getTokenDecimals(dlmmPool.lbPair.tokenYMint);  // SOL 精度
    
    // 先读取池名称以获取 X 代币名称
    const poolJson = readPoolJson(poolAddress.toString());
    const poolName = poolJson?.data?.poolName || poolJson?.poolName || 'UNKNOWN-SOL';
    const xTokenName = poolName.replace('-SOL', '');  // 例如 "BLESS-SOL" -> "BLESS"
    
    console.log(`${xTokenName} 代币精度:`, tokenXDecimals);
    console.log('SOL 代币精度:', tokenYDecimals);

    // ===== 止盈对比（提前进行）：累计已领取(USD) + 当前position(USD) 对比 2.1 SOL(USD) =====
    try {
      const apiUrl = `https://dlmm-api.meteora.ag/position/${positionPubKey.toString()}`;
      const resp = await axios.get(apiUrl, { timeout: 10000 });
      const data = resp?.data;
      if (data && typeof data.total_fee_usd_claimed === 'number' && typeof data.total_reward_usd_claimed === 'number') {
        const totalUsd = Number(data.total_fee_usd_claimed) + Number(data.total_reward_usd_claimed);
        console.log(`💵 累计已领取(USD): fee=${data.total_fee_usd_claimed}, reward=${data.total_reward_usd_claimed}, sum=${totalUsd}`);

        // 读取 position 的当前持仓 X/Y（最小单位），换算为实际数量
        const currentX = getRawAmount(position.positionData.totalXAmount) / Math.pow(10, tokenXDecimals);
        const currentY = getRawAmount(position.positionData.totalYAmount) / Math.pow(10, tokenYDecimals);

        // 获取 X 与 SOL 的 USD 价格（优先使用 OKX API 实时获取）
        // X 价格文件名为 ca（token 合约地址），来自 pool JSON；非 mint 地址
        const caX = readTokenContractAddressFromPoolJson(poolAddress.toString());
        const solMint = 'So11111111111111111111111111111111111111112';
        
        // 优先使用 OKX API 获取 X 代币价格，失败则回退到本地缓存
        let xUsdPrice: number | undefined;
        if (caX) {
          try {
            console.log('🔄 正在通过 OKX API 获取 X 代币最新价格...');
            const xPriceStr = await fetchOkxLatestPrice(caX);
            if (xPriceStr) {
              xUsdPrice = Number(xPriceStr);
              console.log(`✅ OKX API 获取 X 代币价格成功: ${xUsdPrice}`);
            } else {
              console.log('⚠️ OKX API 获取 X 代币价格失败，回退到本地缓存');
              xUsdPrice = readUsdPriceFromCache(caX);
            }
          } catch (error) {
            console.log('⚠️ OKX API 获取 X 代币价格异常，回退到本地缓存:', error instanceof Error ? error.message : String(error));
            xUsdPrice = readUsdPriceFromCache(caX);
          }
        }
        
        // SOL 价格通过 fetchPrice.ts 的方法实时获取（字符串转 number）
        const solPriceStr = await fetchOkxLatestPriceFromModule(solMint);
        const solUsdPrice = solPriceStr ? Number(solPriceStr) : undefined;

        if (xUsdPrice !== undefined && solUsdPrice !== undefined) {
          const currentPositionUsd = currentX * xUsdPrice + currentY * solUsdPrice;
          const baseSumUsd = totalUsd + currentPositionUsd;
          // 计算未领取费用的USD价值（X费用 + SOL费用）
          const pendingFeeX = position.positionData.feeX.toNumber() / Math.pow(10, tokenXDecimals);
          const pendingFeeY = position.positionData.feeY.toNumber() / Math.pow(10, tokenYDecimals);
          const pendingUsdX = pendingFeeX * xUsdPrice;
          const pendingUsdY = pendingFeeY * solUsdPrice;
          const pendingUsdSum = pendingUsdX + pendingUsdY;
          const sumUsd = baseSumUsd + pendingUsdSum;
          console.log('currentX为:', currentX);
          console.log('currentY为:', currentY);
          console.log('xUsdPrice为:', xUsdPrice);
          console.log('solUsdPrice为:', solUsdPrice);
          console.log(`💰 当前position价值(USD): X=${(currentX * xUsdPrice).toFixed(6)}, Y=${(currentY * solUsdPrice).toFixed(6)}, sum=${currentPositionUsd.toFixed(6)}`);
          console.log(`💤 未领取费用USD价值: X=${pendingUsdX.toFixed(6)}, Y=${pendingUsdY.toFixed(6)}, sum=${pendingUsdSum.toFixed(6)}`);
          console.log(`💰 累计已领取USD + 当前positionUSD + 未领取费用USD: ${(sumUsd).toFixed(6)}`);
          console.log(`🪙 1 SOL 的USD价格: ${solUsdPrice}`);
          console.log(`🪙 2 SOL 的USD价格: ${2 * solUsdPrice}`);
          const threshold = 2.1 * solUsdPrice;
          console.log('threshold为:', threshold);
          if (sumUsd >= threshold) {
            console.log('✅ (累计已领取USD + 当前positionUSD + 未领取费用USD) ≥ 2.1 SOL 的USD，触发移除流动性');
            // 触发移除流动性，执行内部swap
            try {
              const cmd = `npx ts-node removeLiquidity.ts --pool=${poolAddress.toString()} --position=${positionPubKey.toString()}`;
              console.log(`🛠️ 触发移除流动性: ${cmd}`);
              const { stdout, stderr } = await execAsync(cmd, { cwd: '/Users/yqw/meteora_dlmm' });
              if (stdout) console.log(stdout);
              if (stderr) console.error(stderr);
            } catch (e) {
              console.error('❌ 触发移除流动性失败:', e);
            }
            // 直接返回，避免继续领取
            return;
          } else {
            console.log('❌ (累计领取USD + 当前positionUSD) 未达到 2.1 SOL 的USD，继续流程');
          }
        } else {
          console.log('⚠️ 本地价格缓存缺失(X或SOL)，跳过对比');
        }
      } else {
        console.log('⚠️ Meteora API 返回缺少累计领取USD字段');
      }
    } catch (e) {
      console.log('⚠️ 调用 Meteora API 获取累计领取USD失败:', e instanceof Error ? e.message : String(e));
    }

    // 获取可领取费用（原始值）
    const claimableFeeX = position.positionData.feeX;  // X 费用
    const claimableFeeY = position.positionData.feeY;  // SOL 费用
    
    // 转换为实际数量
    const actualClaimableFeeX = claimableFeeX.toNumber() / Math.pow(10, tokenXDecimals);
    const actualClaimableFeeY = claimableFeeY.toNumber() / Math.pow(10, tokenYDecimals);
    
    console.log(`可领取 ${xTokenName} 费用 (原始):`, claimableFeeX.toString());
    console.log('可领取 SOL 费用 (原始):', claimableFeeY.toString());
    console.log(`可领取 ${xTokenName} 费用 (实际):`, actualClaimableFeeX);
    console.log('可领取 SOL 费用 (实际):', actualClaimableFeeY);

    // 获取价格系数 c
    const c = poolJson?.c ? parseFloat(poolJson.c) : 0;
    
    console.log('池名称:', poolName);
    console.log('X代币名称:', xTokenName);
    console.log('价格系数 c:', c);
    
    // 使用 data/prices/<ca>.json 的最新价格计算 X 费用价值
    const caForX = readTokenContractAddressFromPoolJson(poolAddress.toString());
    const latestXPrice = caForX ? readUsdPriceFromCache(caForX) : undefined;
    if (latestXPrice === undefined) {
      console.log('⚠️ 未找到 X 的最新价格，跳过领取');
      return;
    }
    const feeValue = actualClaimableFeeX * latestXPrice;
    console.log(`${xTokenName}费用价值 (${xTokenName} * latestPrice):`, feeValue);

    // 上方止盈判断处已输出“未领取费用USD价值”，此处不再重复打印
    
    // 判断是否领取（只判断 X 费用价值，SOL 费用不判断）
    if (feeValue > 1.8) {
      console.log(`✅ ${xTokenName}费用价值大于 1.8，继续领取...`);
    } else {
      console.log(`❌ ${xTokenName}费用价值小于等于 1.8，跳过领取`);
      return;
    }

    // 4. 准备用户密钥对
    let userKeypair: Keypair;
    if (process.env.PRIVATE_KEY_ENCRYPTED === 'true') {
      if (!process.env.PRIVATE_KEY_PASSWORD) {
        throw new Error('使用加密私钥时，必须设置PRIVATE_KEY_PASSWORD环境变量');
      }
      const decryptedPrivateKey = decryptPrivateKey(process.env.PRIVATE_KEY!, process.env.PRIVATE_KEY_PASSWORD);
      userKeypair = Keypair.fromSecretKey(bs58.decode(decryptedPrivateKey));
      console.log('✅ 从环境变量加载钱包 (加密私钥)');
    } else {
      userKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
      console.log('✅ 从环境变量加载钱包 (明文私钥)');
    }

    const owner = new PublicKey(process.env.USER_WALLET_ADDRESS!);

    console.log('=== 领取奖励（按单仓位） ===');
    console.log('用户地址:', owner.toString());
    console.log('仓位地址:', positionPubKey.toString(), cliPosition ? '(来自命令行)' : '(来自环境变量)');
    console.log('池地址:', poolAddress.toString(), cliPool ? '(来自命令行)' : '(来自环境变量)');

    // 5. 构建领取交易（可能返回多笔）
    // 若报错为 "No fee/reward to claim"，视为正常，不重试
    let transactions;
    try {
      transactions = await dlmmPool.claimAllRewardsByPosition({ owner, position });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg && msg.includes('No fee/reward to claim')) {
        console.log('没有可领取的手续费或奖励');
        return;
      }
      // 仅非上述错误才启用重试
      transactions = await withRetry(() => dlmmPool.claimAllRewardsByPosition({ owner, position }), 'dlmmPool.claimAllRewardsByPosition');
    }

    if (transactions.length === 0) {
      console.log('没有可领取的手续费或奖励');
      return;
    }

    console.log(`生成了 ${transactions.length} 个交易`);

    // 6. 依次签名并发送
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      console.log(`执行交易 ${i + 1}/${transactions.length}...`);

      transaction.sign(userKeypair as any);
      const versionedTransaction = new VersionedTransaction(transaction.compileMessage());
      versionedTransaction.sign([userKeypair as any]);

      const txHash = await withRetry(() => connection.sendTransaction(versionedTransaction), 'connection.sendTransaction');
      console.log(`交易 ${i + 1} 哈希:`, txHash);

      await withRetry(() => connection.getSignatureStatus(txHash, { searchTransactionHistory: true }), 'connection.getSignatureStatus');
      console.log(`交易 ${i + 1} 已确认`);
    }

    console.log('✅ 领取完成');
    
    // 领取成功后智能等待代币到账，然后执行 jupSwap
    const ca = readTokenContractAddressFromPoolJson(poolAddress.toString());
    if (ca) {
      console.log(`⏳ 领取成功，等待代币到账后执行 jupSwap: ${ca}`);
      await waitForTokenAndExecuteJupSwap(ca);
    } else {
      console.log('⚠️ 未找到 token 合约地址，跳过 jupSwap');
    }
    
  } catch (error) {
    console.error('错误:', error instanceof Error ? error.message : String(error));
  }
}

// 运行
if (require.main === module) {
  claimAllRewardsByPosition();
}

export { claimAllRewardsByPosition };


