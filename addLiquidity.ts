import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction,
  VersionedTransaction,
  clusterApiUrl
} from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import CryptoJS from 'crypto-js';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';

// 加载环境变量
dotenv.config();

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 从命令行与环境变量读取配置（命令行优先）
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

// 控制是否启用 OKX 抓取（默认关闭，需要显式开启）
function resolveEnableOkxFromArgs(): boolean | undefined {
  for (const arg of argv) {
    if (arg === '--enable-okx') return true;
    if (arg.startsWith('--enable-okx=')) {
      const v = sanitizeString(arg.split('=')[1]).toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
      if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    }
  }
  return undefined;
}

// 从命令行读取 last_updated_first（仅命令行传入）
function resolveLastUpdatedFirstFromArgs(): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--last_updated_first=')) {
      const raw = arg.substring('--last_updated_first='.length);
      return sanitizeLastUpdatedFirst(raw);
    }
    if (arg === '--last_updated_first') {
      const part1 = argv[i + 1];
      const part2 = argv[i + 2];
      if (part1 && part2) {
        return sanitizeLastUpdatedFirst(`${part1} ${part2}`);
      }
      if (part1) {
        return sanitizeLastUpdatedFirst(part1);
      }
    }
  }
  return undefined;
}

// 通用的引号处理函数：去掉包裹引号、处理%20/T分隔、去除转义符
function sanitizeString(input: string): string {
  let s = input.trim();
  // 去掉首尾引号或反引号
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\'')) || (s.startsWith('`') && s.endsWith('`'))) {
    s = s.slice(1, -1);
  }
  // 去掉尾部转义的引号
  if (s.endsWith('\\"') || s.endsWith('\\\'')) {
    s = s.slice(0, -2);
  }
  // 替换 URL 编码空格
  s = s.replace(/%20/g, ' ');
  // 替换 T 为空格（仅在日期时间格式中）
  // s = s.replace('T', ' '); // 注释掉这行，因为它会错误地替换地址中的T字符
  return s.trim();
}

// 规范化 last_updated_first 字符串：去掉包裹引号、处理%20/T分隔、去除转义符
function sanitizeLastUpdatedFirst(input: string): string {
  return sanitizeString(input);
}

const USER_WALLET_ADDRESS = new PublicKey(process.env.USER_WALLET_ADDRESS!);

// 通用重试工具：失败等待1秒再试，共最多3次（首试+重试2次）
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

// 代币精度
const TOKEN_Y_DECIMAL = 9;  //sol

/**
 * 计算动态左侧bins数量
 * @param bin_step bin步长
 * @returns 左侧bins数量
 */
function calculateDynamicLeftBins(bin_step: number): number {
  // 目标值：0.4
  const targetValue = 0.4;  //-60%
  // 基础值：1 - bin_step/10000
  const baseValue = 1 - bin_step / 10000;
  
  // 使用对数计算：leftBins = log(targetValue) / log(baseValue)
  const leftBins = Math.log(targetValue) / Math.log(baseValue);
  
  // 返回向上取整的整数，+1bin
  return Math.ceil(leftBins) + 1;
}

/**
 * 解析东八区时间串为毫秒时间戳，并将秒归零
 * 格式示例：2025-09-11 05:02:26
 */
function parseLastUpdatedFirstToMillisEast8(input: string): number {
  // 拆分日期与时间
  const [datePart, timePart] = input.trim().split(' ');
  if (!datePart || !timePart) throw new Error('last_updated_first 格式错误，应为 YYYY-MM-DD HH:mm:ss');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number); // 秒将置零
  if ([year, month, day, hour, minute].some((v) => Number.isNaN(v))) {
    throw new Error('last_updated_first 解析失败：存在非法数字');
  }
  // 东八区：使用 Date.UTC 再减去8小时得到 UTC 时间戳
  const utcMillis = Date.UTC(year, (month - 1), day, hour - 8, minute, 0, 0);
  return utcMillis;
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
 * 使用createExtendedEmptyPosition创建大范围仓位（支持超过70个bins）
 * @param dlmmPool DLMM池实例
 * @param userPublicKey 用户公钥
 * @param minBinId 最小bin ID
 * @param maxBinId 最大bin ID
 */
async function createExtendedEmptyPosition(
  dlmmPool: any,
  userPublicKey: PublicKey,
  minBinId: number,
  maxBinId: number
): Promise<{ transaction: Transaction; positionKeypair: Keypair }> {
  
  // 创建新的仓位密钥对
  const positionKeypair = new Keypair();
  
  // 调用createExtendedEmptyPosition方法
  const transaction = await dlmmPool.createExtendedEmptyPosition(
    minBinId,                    // lowerBinid
    maxBinId,                    // upperBinId
    positionKeypair.publicKey,   // position
    userPublicKey                // owner
  );
  
  return { transaction, positionKeypair };
}

/**
 * 从 OKX DEX 获取指定 token 的 1m K线数据并输出
 * 固定参数：chainIndex=501, bar=1m, limit=10
 * 其余参数（after/before）保留为空
 */
async function fetchOkxCandles(tokenContractAddress: string, after?: string, before?: string): Promise<any> {
  const baseUrl = 'https://web3.okx.com/api/v5/dex/market/historical-candles';
  const params = new URLSearchParams();
  params.set('chainIndex', '501');
  params.set('tokenContractAddress', tokenContractAddress);
  params.set('bar', '1m');
  params.set('limit', '10');
  if (after) params.set('after', after);
  if (before) params.set('before', before);
  const url = `${baseUrl}?${params.toString()}`;

  const data = await withRetry<any>(
    () => new Promise<any>((resolve, reject) => {
      https.get(url, (res) => {
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP 状态码 ${statusCode}`));
          res.resume();
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        });
      }).on('error', (e) => reject(e));
    }),
    'OKX DEX 1m K线'
  );

  console.log('OKX DEX 1m K线（limit=10）响应:');
  console.log(JSON.stringify(data, null, 2));
  return data;
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
 * 使用扩展仓位添加流动性（支持大于70个bins）
 * @param dlmmPool DLMM池实例
 * @param userPublicKey 用户公钥
 * @param tokenXAmount Token X 数量
 * @param tokenYAmount Token Y 数量
 * @param minBinId 最小bin ID
 * @param maxBinId 最大bin ID
 * @param slippage 滑点百分比
 */
async function addLiquidityWithExtendedPosition(
  dlmmPool: any,
  userPublicKey: PublicKey,
  tokenXAmount: BN,
  tokenYAmount: BN,
  minBinId: number,
  maxBinId: number,
  slippage: number = 0.1
): Promise<{ createTransaction: Transaction; addLiquidityTransaction: Transaction; positionKeypair: Keypair }> {
  
  // 步骤1: 创建扩展空仓位
  const { transaction: createTransaction, positionKeypair } = await createExtendedEmptyPosition(
    dlmmPool,
    userPublicKey,
    minBinId,
    maxBinId
  );
  
  // 步骤2: 添加流动性到扩展仓位
  const strategy = {
    strategyType: StrategyType.BidAsk,
    minBinId: minBinId,
    maxBinId: maxBinId,
  };
  
  const addLiquidityTransaction = await dlmmPool.addLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: tokenXAmount,
    totalYAmount: tokenYAmount,
    strategy: strategy,
    user: userPublicKey,
    slippage: slippage
  });
  
  return { createTransaction, addLiquidityTransaction, positionKeypair };
}

/**
 * 占位：根据 last_updated_first 计算 Bin 范围
 * 后续将按你的详细规则实现
 */
function calculateBinsFromLastUpdatedFirst(
  lastUpdatedFirst: string,
  activeId: number,
  binStep: number
): { minBinId: number; maxBinId: number } {
  // 占位策略：暂时复用旧逻辑，后续替换为真实算法
  const leftBins = calculateDynamicLeftBins(binStep);
  const minBinId = activeId - leftBins;
  const maxBinId = activeId - 1;
  return { minBinId, maxBinId };
}

/**
 * 新的bin范围计算方式
 * 当最新价格 > 收盘价时使用
 * @param latestPrice 最新价格
 * @param cPrice 收盘价
 * @param activeId 当前活跃bin ID
 * @param binStep bin步长
 * @returns bin范围
 */
function calculateNewBinRange(
  latestPrice: number,
  cPrice: number,
  activeId: number,
  binStep: number
): { minBinId: number; maxBinId: number } {
  console.log(`🔄 新bin计算方式:`);
  console.log(`- 最新价格: ${latestPrice}`);
  console.log(`- 收盘价: ${cPrice}`);
  console.log(`- 价格涨幅: ${((latestPrice - cPrice) / cPrice * 100).toFixed(2)}%`);
  
  // 计算新的targetValue: 1 - (latestPriceNum - cPriceNum) / latestPriceNum
  const priceChangeRatio = (latestPrice - cPrice) / latestPrice;
  const targetValue = 1 - priceChangeRatio;
  
  console.log(`- 价格变化比例: ${(priceChangeRatio * 100).toFixed(2)}%`);
  console.log(`- 新targetValue: ${targetValue.toFixed(6)}`);
  
  // 基础值：1 - bin_step/10000
  const baseValue = 1 - binStep / 10000;
  
  // 使用对数计算：leftBins = log(targetValue) / log(baseValue)
  const leftBins = Math.log(targetValue) / Math.log(baseValue);
  const leftBinsCeiled = Math.ceil(leftBins) + 1;
  
  console.log(`- 基础值: ${baseValue.toFixed(6)}`);
  console.log(`- 计算leftBins: ${leftBins.toFixed(2)}`);
  console.log(`- 向上取整+1: ${leftBinsCeiled}`);
  
  // 计算bin范围
  const maxBinId = activeId - leftBinsCeiled;
  const standardLeftBins = calculateDynamicLeftBins(binStep);
  const minBinId = maxBinId - standardLeftBins;
  
  console.log(`- maxBinId = activeId - leftBins = ${activeId} - ${leftBinsCeiled} = ${maxBinId}`);
  console.log(`- minBinId = maxBinId - standardLeftBins = ${maxBinId} - ${standardLeftBins} = ${minBinId}`);
  
  return { minBinId, maxBinId };
}

/**
 * 完整的BidAsk策略流程（支持大于70个bins）
 * @param dlmmPool DLMM池实例
 * @param userKeypair 用户密钥对
 * @param tokenXAmount Token X 数量
 * @param tokenYAmount Token Y 数量
 * @param minBinId 最小bin ID
 * @param maxBinId 最大bin ID
 * @param slippage 滑点百分比
 */
async function completeBidAskStrategyFlow(
  dlmmPool: any,
  userKeypair: Keypair,
  tokenXAmount: BN,
  tokenYAmount: BN,
  minBinId: number,
  maxBinId: number,
  slippage: number = 0.1
): Promise<{ positionKeypair: Keypair; createTxHash: string; addLiquidityTxHash: string }> {
  
  console.log('=== 开始完整的BidAsk策略流程 ===');
  
  // 步骤1: 创建扩展空仓位
  console.log('步骤1: 创建扩展空仓位');
  const { transaction: createTransaction, positionKeypair } = await createExtendedEmptyPosition(
    dlmmPool,
    userKeypair.publicKey,
    minBinId,
    maxBinId
  );
  
  console.log('✅ 扩展空仓位创建成功');
  console.log('- 仓位地址:', positionKeypair.publicKey.toString());
  console.log('- Bin范围:', `${minBinId} - ${maxBinId} (${maxBinId - minBinId + 1}个bins)`);
  
  // 步骤2: 执行创建交易（让仓位被DLMM程序拥有）
  console.log('步骤2: 执行创建交易');
  createTransaction.sign(positionKeypair as any);
  const versionedCreateTransaction = new VersionedTransaction(createTransaction.compileMessage());
  versionedCreateTransaction.sign([positionKeypair as any]);
  const createTxHash = await connection.sendTransaction(versionedCreateTransaction);
  console.log('✅ 创建交易已发送:', createTxHash);
  
  // 等待交易确认
  await connection.getSignatureStatus(createTxHash, { searchTransactionHistory: true });
  console.log('✅ 创建交易已确认');
  
  // 步骤3: 添加BidAsk策略流动性
  console.log('步骤3: 添加BidAsk策略流动性');
  const strategy = {
    strategyType: StrategyType.BidAsk,
    minBinId: minBinId,
    maxBinId: maxBinId,
  };
  
  const addLiquidityTransaction = await dlmmPool.addLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: tokenXAmount,
    totalYAmount: tokenYAmount,
    strategy: strategy,
    user: userKeypair.publicKey,
    slippage: slippage
  });
  
  // 步骤4: 执行添加流动性交易
  console.log('步骤4: 执行添加流动性交易');
  addLiquidityTransaction.sign(userKeypair as any);
  const versionedAddLiquidityTransaction = new VersionedTransaction(addLiquidityTransaction.compileMessage());
  versionedAddLiquidityTransaction.sign([userKeypair as any]);
  const addLiquidityTxHash = await connection.sendTransaction(versionedAddLiquidityTransaction);
  console.log('✅ 添加流动性交易已发送:', addLiquidityTxHash);
  
  // 等待交易确认
  await connection.getSignatureStatus(addLiquidityTxHash, { searchTransactionHistory: true });
  console.log('✅ 添加流动性交易已确认');
  
  console.log('=== BidAsk策略流程完成 ===');
  console.log('- 仓位地址:', positionKeypair.publicKey.toString());
  console.log('- 创建交易:', createTxHash);
  console.log('- 添加流动性交易:', addLiquidityTxHash);
  
  return { positionKeypair, createTxHash, addLiquidityTxHash };
}


/**
 * 主函数 - 演示如何使用 createExtendedEmptyPosition 和 addLiquidityByStrategy
 */
async function main() {
  try {
    // 验证必需的环境变量
    const requiredEnvVars = [
      'PRIVATE_KEY',
      'POOL_ADDRESS', 
      'USER_WALLET_ADDRESS',
      'SOL_AMOUNT'
    ];
    
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`缺少必需的环境变量: ${envVar}`);
      }
    }
    
    console.log('✅ 所有环境变量配置完成');
    // Bin 计算模式切换：默认 last_updated_first，可在 .env 配置 BIN_RANGE_MODE
    const binRangeMode = (process.env.BIN_RANGE_MODE || 'last_updated_first').toLowerCase();
    console.log(`📊 模式: ${binRangeMode === 'last_updated_first' ? 'last_updated_first' : '自动计算Bin ID'}`);
    
    // 解析POOL_ADDRESS（命令行优先，其次.env）
    const cliPoolAddress = resolvePoolAddressFromArgs();
    const poolAddressStr = cliPoolAddress || process.env.POOL_ADDRESS;
    if (!poolAddressStr) {
      throw new Error('缺少必需的POOL_ADDRESS，请通过 --pool=  传入，或在.env中设置');
    }
    const POOL_ADDRESS = new PublicKey(poolAddressStr);
    console.log(`使用的POOL_ADDRESS: ${POOL_ADDRESS.toString()}${cliPoolAddress ? ' (来自命令行)' : ' (来自.env)'}`);
    
    // 创建DLMM池实例（带重试）
    const dlmmPool = await withRetry(() => DLMM.create(connection, POOL_ADDRESS), 'DLMM.create');
    
    // 单边池参数 - tokenXAmount为0，只提供tokenY
    const tokenXAmount = new BN(0); // 单边池，Token X 数量为0
    
    // 从环境变量读取SOL数量
    const solAmount = parseFloat(process.env.SOL_AMOUNT!);
    const tokenYAmount = new BN(solAmount * 10 ** TOKEN_Y_DECIMAL); // SOL数量乘以精度
    
    // 计算Bin ID范围
    let minBinId: number = 0;
    let maxBinId: number = 0;
    const binStep = dlmmPool.lbPair.binStep;
    let binRangeCalculated = false; // 标记是否已通过价格比较计算bin范围

    // 新模式：基于 last_updated_first（仅命令行输入），默认启用
    const lastUpdatedFirst = resolveLastUpdatedFirstFromArgs();
    if (binRangeMode === 'last_updated_first' && lastUpdatedFirst) {
      // 注意：如果启用了OKX且提供了token地址，bin范围将在价格比较后计算
      // 这里先不计算，等待价格比较逻辑
      const initialActiveId = dlmmPool.lbPair.activeId;
      console.log(`🔢 last_updated_first 模式准备计算 Bin ID 范围:`);
      console.log(`- Active ID: ${initialActiveId} (初始获取)`);
      console.log(`- Bin Step: ${binStep} (从池中获取)`);
      console.log(`- last_updated_first: ${lastUpdatedFirst}`);
    } else {
      // 兼容旧逻辑：自动从 activeId 向左扩展
      // 实时获取当前活跃Bin ID，确保时效性
      const currentActiveId = dlmmPool.lbPair.activeId;
      const leftBins = calculateDynamicLeftBins(binStep);
      maxBinId = currentActiveId - 1;  // activeId-1为maxBinId
      minBinId = currentActiveId - leftBins;  // activeId-leftBins为minBinId
      binRangeCalculated = true;
      console.log(`🔢 自动计算Bin ID范围:`);
      console.log(`- Active ID: ${currentActiveId} (实时获取)`);
      console.log(`- Bin Step: ${binStep} (从池中获取)`);
      console.log(`- 左侧Bins数量: ${leftBins}`);
      console.log(`- Min Bin ID: ${minBinId}`);
      console.log(`- Max Bin ID: ${maxBinId}`);
      console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
    } 
    
    // 创建用户密钥对（仅支持加密私钥，解密后为Base58格式）
    let userKeypair: Keypair;
    if (!process.env.PRIVATE_KEY) {
      console.log('❌ 未找到私钥配置');
      throw new Error('未配置私钥，请在.env文件中设置PRIVATE_KEY');
    }
    if (process.env.PRIVATE_KEY_ENCRYPTED !== 'true') {
      throw new Error('仅支持加密私钥：请将 PRIVATE_KEY_ENCRYPTED 设置为 true');
    }
    if (!process.env.PRIVATE_KEY_PASSWORD) {
      throw new Error('使用加密私钥时，必须设置 PRIVATE_KEY_PASSWORD');
    }
    let decryptedPrivateKeyBase58: string;
    try {
      decryptedPrivateKeyBase58 = decryptPrivateKey(process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_PASSWORD);
      console.log('✅ 已解密加密私钥');
    } catch (e) {
      console.log('❌ 私钥解密失败');
      throw new Error('私钥解密失败，请检查 PRIVATE_KEY 与 PRIVATE_KEY_PASSWORD 是否匹配');
    }
    try {
      userKeypair = Keypair.fromSecretKey(bs58.decode(decryptedPrivateKeyBase58));
      console.log('✅ 私钥格式：Base58 (解密后)');
    } catch (e) {
      throw new Error('解密后的私钥必须是 Base58 的 secret key');
    }
    
    console.log('用户钱包地址:', userKeypair.publicKey.toString());
    console.log('配置的钱包地址:', USER_WALLET_ADDRESS.toString());
    console.log('SOL数量:', solAmount, 'SOL');
    console.log('Token Y 数量:', tokenYAmount.toString(), 'lamports');
    console.log('Bin ID范围:', `${minBinId} - ${maxBinId} (${maxBinId - minBinId + 1}个bins)`);
    
    // 验证钱包地址是否匹配
    if (userKeypair.publicKey.toString() !== USER_WALLET_ADDRESS.toString()) {
      console.log('⚠️  警告：生成的钱包地址与配置的地址不匹配');
      console.log('建议：在.env文件中设置正确的PRIVATE_KEY');
    }
    
    // 检查钱包余额
    try {
      const balance = await connection.getBalance(userKeypair.publicKey);
      const balanceSOL = balance / 1e9;
      console.log(`💰 钱包余额: ${balanceSOL.toFixed(6)} SOL (${balance} lamports)`);
      
      if (balance < 60000000) { // 0.06 SOL
        console.log('⚠️  余额不足！建议充值至少 0.06 SOL');
        console.log('需要支付：账户租金 + 交易费用');
      } else {
        console.log('✅ 余额充足，可以继续交易');
      }
    } catch (error) {
      console.log('❌ 无法获取余额信息');
    }
    
    // 获取 OKX DEX K线和价格（默认关闭，仅显式开启时执行）
    const tokenFromCli = resolveTokenAddressFromArgs();
    const enableOkxFlag = resolveEnableOkxFromArgs();
    const enableOkxEnv = (process.env.ENABLE_OKX || '').toLowerCase();
    const enableOkx = enableOkxFlag ?? (enableOkxEnv === '1' || enableOkxEnv === 'true' || enableOkxEnv === 'yes' || enableOkxEnv === 'on');
    let latestPrice: string | undefined;
    
    if (enableOkx && tokenFromCli) {
      // 先尝试获取最新价格（不阻塞 K 线）
      try {
        latestPrice = await fetchOkxLatestPrice(tokenFromCli);
        if (latestPrice !== undefined) {
          console.log('OKX DEX 最新价格:', latestPrice);
        } else {
          console.log('未获取到 OKX 最新价格');
        }
      } catch (e) {
        console.log('获取 OKX 最新价格失败:', e instanceof Error ? e.message : String(e));
      }

      // 再获取 K 线
      try {
        const kline = await fetchOkxCandles(tokenFromCli);
        const lastUpdatedFirst = resolveLastUpdatedFirstFromArgs();
        if (lastUpdatedFirst) {
          try {
            const targetTs = parseLastUpdatedFirstToMillisEast8(lastUpdatedFirst);
            const rows: any[] = Array.isArray(kline?.data) ? kline.data : [];
            // OKX 返回 data 为二维数组: [ts, o, h, l, c, baseVol, quoteVol, ...]
            const hit = rows.find((row: any[]) => String(row?.[0]) === String(targetTs));
            if (hit) {
              const c = hit[4];
              console.log(`last_updated_first 命中收盘价(c): ${c}`);
              
              // 使用已经获取到的最新价格进行比较（避免重复API请求）
              if (latestPrice !== undefined) {
                // 实时获取当前活跃Bin ID，确保时效性
                const currentActiveId = dlmmPool.lbPair.activeId;
                const latestPriceNum = parseFloat(latestPrice);
                const cPriceNum = parseFloat(c);
                
                console.log(`价格比较:`);
                console.log(`- 收盘价(c): ${cPriceNum}`);
                console.log(`- 最新价格: ${latestPriceNum}`);
                console.log(`- 当前Active ID: ${currentActiveId} (实时获取)`);
                
                if (latestPriceNum <= cPriceNum) {
                  console.log(`✅ 最新价格 <= 收盘价，使用自动模式计算bin范围`);
                  // 使用自动模式计算bin范围
                  const leftBins = calculateDynamicLeftBins(binStep);
                  minBinId = currentActiveId - leftBins;
                  maxBinId = currentActiveId - 1;
                  binRangeCalculated = true;
                  console.log(`🔢 自动模式Bin ID范围:`);
                  console.log(`- Active ID: ${currentActiveId}`);
                  console.log(`- Bin Step: ${binStep}`);
                  console.log(`- 左侧Bins数量: ${leftBins}`);
                  console.log(`- Min Bin ID: ${minBinId}`);
                  console.log(`- Max Bin ID: ${maxBinId}`);
                  console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
                } else {
                  console.log(`✅ 最新价格 > 收盘价，使用新的计算bin范围方式`);
                  // 使用新的计算bin范围方式
                  const result = calculateNewBinRange(latestPriceNum, cPriceNum, currentActiveId, binStep);
                  minBinId = result.minBinId;
                  maxBinId = result.maxBinId;
                  binRangeCalculated = true;
                  console.log(`🔢 新方式Bin ID范围:`);
                  console.log(`- Active ID: ${currentActiveId}`);
                  console.log(`- Bin Step: ${binStep}`);
                  console.log(`- Min Bin ID: ${minBinId}`);
                  console.log(`- Max Bin ID: ${maxBinId}`);
                  console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
                }
              } else {
                console.log('未获取到最新价格，停止执行');
                return; // 直接停止，不再继续默认 last_updated_first 模式
              }
            } else {
              console.log('未在 K 线中找到匹配时间戳');
            }
          } catch (e) {
            console.log('解析 last_updated_first 失败:', e instanceof Error ? e.message : String(e));
          }
        }
      } catch (e) {
        console.log('获取 OKX DEX K线失败:', e instanceof Error ? e.message : String(e));
      }
    } else {
      if (!enableOkx) {
        console.log('OKX 抓取默认关闭；可用 --enable-okx 或 ENABLE_OKX=true 显式开启');
      } else {
        console.log('未提供 tokenContractAddress（--token= 或 --token-address=），跳过 OKX DEX 抓取');
      }
    }
    
    // 如果还没有计算bin范围，使用默认的last_updated_first模式
    if (!binRangeCalculated && binRangeMode === 'last_updated_first' && lastUpdatedFirst) {
      // 实时获取当前活跃Bin ID，确保时效性
      const currentActiveId = dlmmPool.lbPair.activeId;
      const result = calculateBinsFromLastUpdatedFirst(lastUpdatedFirst, currentActiveId, binStep);
      minBinId = result.minBinId;
      maxBinId = result.maxBinId;
      binRangeCalculated = true;
      console.log(`🔢 默认last_updated_first模式计算 Bin ID 范围:`);
      console.log(`- Active ID: ${currentActiveId} (实时获取)`);
      console.log(`- Bin Step: ${binStep} (从池中获取)`);
      console.log(`- last_updated_first: ${lastUpdatedFirst}`);
      console.log(`- Min Bin ID: ${minBinId}`);
      console.log(`- Max Bin ID: ${maxBinId}`);
      console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
    }
    
    // 验证activeId是否大于或等于maxBinId（在所有bin范围计算完成后）
    const finalActiveId = dlmmPool.lbPair.activeId;
    if (finalActiveId < maxBinId) {
        throw new Error(`activeId (${finalActiveId}) 必须大于或等于 maxBinId (${maxBinId})`);
    }

    // 等待一段时间
    // console.log('等待 20 秒...');
    // await new Promise(resolve => setTimeout(resolve, 20000));

    // 使用createExtendedEmptyPosition创建大范围仓位
    const { transaction: createTransaction, positionKeypair } = await withRetry(
      () => createExtendedEmptyPosition(
        dlmmPool,
        userKeypair.publicKey,
        minBinId,
        maxBinId
      ),
      'dlmmPool.createExtendedEmptyPosition'
    );

    // 发送并确认创建仓位交易
    console.log('发送创建仓位交易...');
    createTransaction.sign(userKeypair as any, positionKeypair as any);
    const versionedCreateTransaction = new VersionedTransaction(createTransaction.compileMessage());
    versionedCreateTransaction.sign([userKeypair as any, positionKeypair as any]);
    const createTxHash = await withRetry(() => connection.sendTransaction(versionedCreateTransaction), 'connection.sendTransaction(create)');
    console.log('创建交易哈希:', createTxHash);
    
    // 等待交易确认
    console.log('等待交易确认...');
    let confirmed = false;
    let attempts = 0;
    const maxAttempts = 30; // 最多等待30秒
    
    while (!confirmed && attempts < maxAttempts) {
      try {
        const status = await withRetry(() => connection.getSignatureStatus(createTxHash, { searchTransactionHistory: true }), 'connection.getSignatureStatus(create)');
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
          confirmed = true;
          console.log('✅ 创建交易已确认');
        } else {
          console.log(`等待确认中... (${attempts + 1}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒
          attempts++;
        }
      } catch (error) {
        console.log(`确认检查失败: ${error}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }
    }
    
    if (!confirmed) {
      throw new Error('创建交易确认超时');
    }
    
    // 使用addLiquidityByStrategy添加流动性
    try {
      const strategy = {
        strategyType: StrategyType.BidAsk,
        minBinId: minBinId,
        maxBinId: maxBinId,
      };
      
      const addLiquidityTransaction = await withRetry(() => dlmmPool.addLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        totalXAmount: tokenXAmount,
        totalYAmount: tokenYAmount,
        strategy: strategy,
        user: userKeypair.publicKey,
        slippage: 0.1
      }), 'dlmmPool.addLiquidityByStrategy');
      
      // 发送并确认添加流动性交易
      console.log('发送添加流动性交易...');
      addLiquidityTransaction.sign(userKeypair as any);
      const versionedAddLiquidityTransaction = new VersionedTransaction(addLiquidityTransaction.compileMessage());
      versionedAddLiquidityTransaction.sign([userKeypair as any]);
      const addLiquidityTxHash = await withRetry(() => connection.sendTransaction(versionedAddLiquidityTransaction), 'connection.sendTransaction(addLiquidity)');
      console.log('添加流动性交易哈希:', addLiquidityTxHash);
      
      // 等待交易确认
      await withRetry(() => connection.getSignatureStatus(addLiquidityTxHash, { searchTransactionHistory: true }), 'connection.getSignatureStatus(addLiquidity)');
      console.log('添加流动性交易已确认');
      
      console.log('=== 交易完成 ===');
      console.log('仓位地址:', positionKeypair.publicKey.toString());
      console.log('创建交易:', createTxHash);
      console.log('添加流动性交易:', addLiquidityTxHash);
      
      // 将 positionAddress 持久化到对应池子的 JSON 文件中
      try {
        const poolFile = path.resolve(__dirname, 'data', `${POOL_ADDRESS.toString()}.json`);
        let json: any = {};
        try {
          const raw = fs.readFileSync(poolFile, 'utf8');
          json = JSON.parse(raw);
        } catch (e) {
          // 若文件不存在或解析失败，则使用空对象，避免中断主流程
          json = {};
        }

        const posAddr = positionKeypair.publicKey.toString();
        // 记录到顶层便于其他脚本读取
        json.positionAddress = posAddr;
        // 同步到 data 区域（若存在）
        if (json.data && typeof json.data === 'object') {
          json.data.positionAddress = posAddr;
        }

        fs.writeFileSync(poolFile, JSON.stringify(json, null, 2));
        console.log(`已写入 positionAddress 到 ${poolFile}`);
      } catch (e: any) {
        console.log('写入 positionAddress 到 JSON 失败:', e?.message || String(e));
      }
      
    } catch (error) {
      console.log(JSON.stringify({
        addLiquidityByStrategy: {
          error: error instanceof Error ? error.message : String(error)
        }
      }, null, 2));
    }

    
  } catch (error) {
    console.error('错误:', error);
  }
}

// 导出函数供其他模块使用
export {
  createExtendedEmptyPosition,
  addLiquidityWithExtendedPosition,
  completeBidAskStrategyFlow,
  main
};

// 如果直接运行此文件，则执行main函数
if (require.main === module) {
  main();
}
