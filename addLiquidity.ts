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
import { spawn } from 'child_process';

// 加载环境变量
dotenv.config();

// 从环境变量读取滑点设置，默认值为0.1
const DEFAULT_SLIPPAGE = 0.1;
const SLIPPAGE_FROM_ENV = process.env.SLIPPAGE_TOLERANCE ? parseFloat(process.env.SLIPPAGE_TOLERANCE) : DEFAULT_SLIPPAGE;

// 从环境变量读取策略类型，默认为Spot
const DEFAULT_STRATEGY = 'Spot';
const STRATEGY_FROM_ENV = process.env.SPOT_STRATEGY || DEFAULT_STRATEGY;

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

// 全局日志前缀注入：[YYYY-MM-DD HH:mm:ss][addLiquidity]
(function setupPrefixedLogger() {
  const FILE_TAG = 'addLiquidity';
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

// 输出当前滑点设置
console.log(`📊 滑点容忍度设置: ${SLIPPAGE_FROM_ENV}% ${process.env.SLIPPAGE_TOLERANCE ? '(来自环境变量)' : '(使用默认值)'}`);

// 输出当前策略设置
console.log(`📊 策略类型设置: ${STRATEGY_FROM_ENV} ${process.env.SPOT_STRATEGY ? '(来自环境变量)' : '(使用默认值)'}`);

/**
 * 从 data/{POOL_ADDRESS}.json 读取 base_fee_percentage_first
 * @param poolAddress 池地址
 * @returns base_fee_percentage_first 的值，如果读取失败返回 null
 */
function readBaseFeePercentageFirst(poolAddress: string): string | null {
  try {
    const poolFile = path.resolve(__dirname, 'data', `${poolAddress}.json`);
    
    if (!fs.existsSync(poolFile)) {
      console.log(`JSON 文件不存在: ${poolFile}`);
      return null;
    }
    
    const jsonData = fs.readFileSync(poolFile, 'utf-8');
    const data = JSON.parse(jsonData);
    
    // 优先从 data 字段读取 base_fee_percentage_first
    let baseFeePercentageFirst = null;
    if (data.data && data.data.base_fee_percentage_first !== undefined) {
      baseFeePercentageFirst = data.data.base_fee_percentage_first;
    }
    
    return baseFeePercentageFirst;
  } catch (error) {
    console.log(`读取 base_fee_percentage_first 失败:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * 将字符串策略类型转换为StrategyType枚举值
 * @param strategyString 策略字符串
 * @returns StrategyType枚举值
 */
function getStrategyType(strategyString: string): StrategyType {
  switch (strategyString.toLowerCase()) {
    case 'spot':
      return StrategyType.Spot;
    case 'curve':
      return StrategyType.Curve;
    case 'bid-ask':
    case 'bidask':
      return StrategyType.BidAsk;
    default:
      console.log(`⚠️ 未知的策略类型: ${strategyString}，使用默认值 Spot`);
      return StrategyType.Spot;
  }
}

/**
 * 根据 base_fee_percentage_first 确定策略类型
 * @param poolAddress 池地址
 * @param defaultStrategy 默认策略类型
 * @returns 策略类型字符串
 */
function determineStrategyType(poolAddress: string, defaultStrategy: string): string {
  const baseFeePercentageFirst = readBaseFeePercentageFirst(poolAddress);
  
  if (baseFeePercentageFirst === "5") {
    console.log(`📊 检测到 base_fee_percentage_first = 5，使用 BidAsk 策略`);
    return "BidAsk";
  } else {
    console.log(`📊 base_fee_percentage_first = ${baseFeePercentageFirst}，使用默认策略: ${defaultStrategy}`);
    return defaultStrategy;
  }
}

// 获取策略类型（将在main函数中根据pool地址动态确定）
let STRATEGY_TYPE: StrategyType;

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
  // 从环境变量获取目标值，默认为0.4
  const targetValue = process.env.TARGET_VALUE ? parseFloat(process.env.TARGET_VALUE) : 0.4;  //-60%
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

  const data = await new Promise<any>((resolve, reject) => {
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
  });

  // console.log('OKX DEX 1m K线（limit=10）响应:');
  // console.log(JSON.stringify(data, null, 2));
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
  slippage: number = SLIPPAGE_FROM_ENV
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
    strategyType: STRATEGY_TYPE,
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
 * 完整的策略流程（支持大于70个bins）
 * @param dlmmPool DLMM池实例
 * @param userKeypair 用户密钥对
 * @param tokenXAmount Token X 数量
 * @param tokenYAmount Token Y 数量
 * @param minBinId 最小bin ID
 * @param maxBinId 最大bin ID
 * @param slippage 滑点百分比
 */
async function completeSpotStrategyFlow(
  dlmmPool: any,
  userKeypair: Keypair,
  tokenXAmount: BN,
  tokenYAmount: BN,
  minBinId: number,
  maxBinId: number,
  slippage: number = SLIPPAGE_FROM_ENV
): Promise<{ positionKeypair: Keypair; createTxHash: string; addLiquidityTxHash: string }> {
  
  console.log(`=== 开始完整的${STRATEGY_FROM_ENV}策略流程 ===`);
  
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
  
  // 步骤3: 添加策略流动性
  console.log(`步骤3: 添加${STRATEGY_FROM_ENV}策略流动性`);
  const strategy = {
    strategyType: STRATEGY_TYPE,
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
  
  // 等待交易确认（带重试和状态检查）
  console.log('等待添加流动性交易确认...');
  let addLiquidityConfirmed = false;
  let addLiquidityAttempts = 0;
  const maxAddLiquidityAttempts = 30;
  while (!addLiquidityConfirmed && addLiquidityAttempts < maxAddLiquidityAttempts) {
    const status = await connection.getSignatureStatus(addLiquidityTxHash, { searchTransactionHistory: true });
    if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
      // 检查交易是否成功（没有错误）
      if (status.value?.err === null) {
        addLiquidityConfirmed = true;
        console.log('✅ 添加流动性交易已确认并成功');
      } else {
        console.log('❌ 添加流动性交易失败:', status.value?.err);
        throw new Error(`添加流动性交易失败: ${JSON.stringify(status.value?.err)}`);
      }
    } else {
      console.log(`等待添加流动性确认中... (${addLiquidityAttempts + 1}/${maxAddLiquidityAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      addLiquidityAttempts++;
    }
  }
  if (!addLiquidityConfirmed) {
    throw new Error('添加流动性交易确认超时');
  }
  
  console.log(`=== ${STRATEGY_FROM_ENV}策略流程完成 ===`);
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
    
    // 根据 base_fee_percentage_first 确定策略类型
    const determinedStrategy = determineStrategyType(POOL_ADDRESS.toString(), STRATEGY_FROM_ENV);
    STRATEGY_TYPE = getStrategyType(determinedStrategy);
    console.log(`📊 最终使用的策略类型: ${determinedStrategy}`);
    
    // 创建DLMM池实例（带重试）
    const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);
    
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
    
    // 从getBinArrays.ts获取实际的minBinId用于比较
    let actualMinBinId: number | null = null;
    try {
      console.log('🔄 正在调用getBinArrays.ts获取实际的minBinId...');
      
      const getBinArraysProcess = spawn('npx', ['ts-node', 'getBinArrays.ts', '-pool', POOL_ADDRESS.toString()], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      getBinArraysProcess.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      
      getBinArraysProcess.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      
      await new Promise<void>((resolve, reject) => {
        getBinArraysProcess.on('close', (code: number) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`getBinArrays.ts 执行失败，退出码: ${code}, stderr: ${stderr}`));
          }
        });
      });
      
      // 解析getBinArrays.ts的输出，查找minBinId
      // 从输出中提取最小binId（支持负数）
      const minBinMatch = stdout.match(/最小binId:\s*(-?\d+)/);
      if (minBinMatch) {
        actualMinBinId = parseInt(minBinMatch[1]);
        console.log(`📋 从getBinArrays.ts获取的实际minBinId: ${actualMinBinId}`);
      } else {
        console.log('📋 未能从getBinArrays.ts输出中解析到minBinId');
        console.log('调试信息 - 输出片段:', stdout.substring(0, 500));
      }
    } catch (e) {
      console.log('📋 调用getBinArrays.ts失败，跳过minBinId比较检查:', e instanceof Error ? e.message : String(e));
    }
    
    // 移动失败文件到fail_minbinId目录的辅助函数
    function moveFailedPoolFile(poolAddress: string): void {
      try {
        const sourceFile = path.resolve(__dirname, 'data', `${poolAddress}.json`);
        const failDir = path.resolve(__dirname, 'data', 'fail_minbinId');
        const targetFile = path.resolve(failDir, `${poolAddress}.json`);
        
        // 确保fail_minbinId目录存在
        if (!fs.existsSync(failDir)) {
          fs.mkdirSync(failDir, { recursive: true });
          console.log(`📁 创建失败目录: ${failDir}`);
        }
        
        // 检查源文件是否存在
        if (fs.existsSync(sourceFile)) {
          // 如果目标文件已存在，添加时间戳后缀
          let finalTargetFile = targetFile;
          if (fs.existsSync(targetFile)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const ext = path.extname(targetFile);
            const name = path.basename(targetFile, ext);
            finalTargetFile = path.resolve(failDir, `${name}_${timestamp}${ext}`);
          }
          
          // 移动文件
          fs.renameSync(sourceFile, finalTargetFile);
          console.log(`📦 已将失败文件移动到: ${finalTargetFile}`);
        } else {
          console.log(`⚠️ 源文件不存在，跳过移动: ${sourceFile}`);
        }
      } catch (error) {
        console.log(`❌ 移动失败文件时出错:`, error instanceof Error ? error.message : String(error));
      }
    }

    // 并行重试函数：在后台重试addLiquidity.ts，不影响当前执行
    function startParallelRetry(poolAddress: string, maxRetries: number = 5, waitTimeMs: number = 60000): void {
      console.log(`🚀 启动并行重试机制: 最多重试${maxRetries}次，每次等待${waitTimeMs/1000}秒`);
      
      // 获取当前脚本的命令行参数，用于重试时传递
      const tokenAddress = resolveTokenAddressFromArgs();
      const lastUpdatedFirst = resolveLastUpdatedFirstFromArgs();
      
      // 使用setImmediate确保不阻塞当前执行
      setImmediate(async () => {
        let allRetriesFailed = true;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            console.log(`⏳ 并行重试第${attempt}次，等待${waitTimeMs/1000}秒...`);
            await new Promise(resolve => setTimeout(resolve, waitTimeMs));
            
            // 构建重试命令参数
            const retryArgs = ['ts-node', 'addLiquidity.ts', `--pool=${poolAddress}`];
            if (tokenAddress) {
              retryArgs.push(`--token=${tokenAddress}`);
            }
            if (lastUpdatedFirst) {
              retryArgs.push(`--last_updated_first=${lastUpdatedFirst}`);
            }
            
            const retryCommand = `npx ${retryArgs.join(' ')}`;
            console.log(`🔄 执行并行重试第${attempt}次: ${retryCommand}`);
            
            const retryProcess = spawn('npx', retryArgs, {
              cwd: __dirname,
              stdio: ['pipe', 'pipe', 'pipe']
            });
            
            let retryStdout = '';
            let retryStderr = '';
            
            retryProcess.stdout.on('data', (data: Buffer) => {
              retryStdout += data.toString();
            });
            
            retryProcess.stderr.on('data', (data: Buffer) => {
              retryStderr += data.toString();
            });
            
            await new Promise<void>((resolve, reject) => {
              retryProcess.on('close', (code: number) => {
                if (code === 0) {
                  console.log(`✅ 并行重试第${attempt}次成功！`);
                  console.log('重试输出:', retryStdout);
                  allRetriesFailed = false; // 标记有成功
                  resolve();
                  return; // 成功则退出重试循环
                } else {
                  console.log(`❌ 并行重试第${attempt}次失败，退出码: ${code}`);
                  if (retryStderr) {
                    console.log('重试错误:', retryStderr);
                  }
                  if (attempt === maxRetries) {
                    console.log(`🚫 并行重试已达到最大次数${maxRetries}，停止重试`);
                    reject(new Error(`重试失败，已达到最大次数`));
                  } else {
                    resolve(); // 继续下一次重试
                  }
                }
              });
            });
            
            // 如果成功，退出重试循环
            break;
            
          } catch (error) {
            console.log(`❌ 并行重试第${attempt}次异常:`, error instanceof Error ? error.message : String(error));
            if (attempt === maxRetries) {
              console.log(`🚫 并行重试已达到最大次数${maxRetries}，停止重试`);
              break;
            }
          }
        }
        
        // 如果所有重试都失败了，移动文件到失败目录
        if (allRetriesFailed) {
          console.log(`💥 所有重试都失败，将移动pool文件到失败目录`);
          moveFailedPoolFile(poolAddress);
        }
      });
    }

    // 比较函数：检查计算出的minBinId是否满足条件
    function validateMinBinId(calculatedMinBinId: number, mode: string): { shouldContinue: boolean; shouldRetry: boolean } {
      if (actualMinBinId === null) {
        console.log(`✅ ${mode}模式：未能获取到实际minBinId，跳过比较检查`);
        return { shouldContinue: true, shouldRetry: false };
      }
      
      console.log(`🔍 ${mode}模式minBinId比较:`);
      console.log(`- 计算出的minBinId: ${calculatedMinBinId}`);
      console.log(`- 实际minBinId (来自getBinArrays.ts): ${actualMinBinId}`);
      
      if (actualMinBinId <= calculatedMinBinId) {
        console.log(`✅ ${mode}模式：实际minBinId (${actualMinBinId}) <= 计算出的minBinId (${calculatedMinBinId})，条件满足`);
        return { shouldContinue: true, shouldRetry: false };
      } else {
        console.log(`❌ ${mode}模式：实际minBinId (${actualMinBinId}) > 计算出的minBinId (${calculatedMinBinId})，条件不满足`);
        console.log(`🔄 将启动并行重试机制`);
        return { shouldContinue: false, shouldRetry: true };
      }
    }

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
      
      // 验证自动模式计算出的minBinId
      const validationResult = validateMinBinId(minBinId, '自动');
      if (!validationResult.shouldContinue) {
        if (validationResult.shouldRetry) {
          startParallelRetry(POOL_ADDRESS.toString());
        }
        return; // 退出程序
      }
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
      
      if (balance < 1100000000) { // 1.1 SOL
        console.log('⚠️  余额不足！建议充值至少 1.1 SOL');
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
        console.log('🔄 正在获取OKX最新价格...');
        latestPrice = await fetchOkxLatestPrice(tokenFromCli);
        if (latestPrice !== undefined) {
          console.log('OKX DEX 最新价格:', latestPrice);
        } else {
          console.log('未获取到 OKX 最新价格');
        }
      } catch (e) {
        console.log('获取 OKX 最新价格失败:', e instanceof Error ? e.message : String(e));
      }

      // 添加延迟避免API限制
      await new Promise(resolve => setTimeout(resolve, 1100));

      // 再获取 K 线
      try {
        console.log('🔄 正在获取OKX K线数据...');
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
              // 将收盘价(c)持久化到 data/<pool>.json（顶层 c 与 data.c 同步，逻辑与 positionAddress 相似）
              try {
                const poolFileForC = path.resolve(__dirname, 'data', `${POOL_ADDRESS.toString()}.json`);
                let jsonC: any = {};
                try {
                  const rawC = fs.readFileSync(poolFileForC, 'utf8');
                  jsonC = JSON.parse(rawC);
                } catch (_) {
                  jsonC = {};
                }
                const cStr = String(c);
                jsonC.c = cStr;
                if (jsonC.data && typeof jsonC.data === 'object') {
                  jsonC.data.c = cStr;
                }
                fs.writeFileSync(poolFileForC, JSON.stringify(jsonC, null, 2));
                console.log(`已写入 收盘价(c) 到 ${poolFileForC}`);
              } catch (e: any) {
                console.log('写入 收盘价(c) 到 JSON 失败:', e?.message || String(e));
              }
              
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
                  maxBinId = currentActiveId -1;
                  binRangeCalculated = true;
                  console.log(`🔢 自动模式Bin ID范围:`);
                  console.log(`- Active ID: ${currentActiveId}`);
                  console.log(`- Bin Step: ${binStep}`);
                  console.log(`- 左侧Bins数量: ${leftBins}`);
                  console.log(`- Min Bin ID: ${minBinId}`);
                  console.log(`- Max Bin ID: ${maxBinId}`);
                  console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
                  
                  // 验证价格比较模式（自动分支）计算出的minBinId
                  const validationResult = validateMinBinId(minBinId, '价格比较-自动');
                  if (!validationResult.shouldContinue) {
                    if (validationResult.shouldRetry) {
                      startParallelRetry(POOL_ADDRESS.toString());
                    }
                    return; // 退出程序
                  }
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
                  
                  // 验证价格比较模式（新方式分支）计算出的minBinId
                  const validationResult = validateMinBinId(minBinId, '价格比较-新方式');
                  if (!validationResult.shouldContinue) {
                    if (validationResult.shouldRetry) {
                      startParallelRetry(POOL_ADDRESS.toString());
                    }
                    return; // 退出程序
                  }
                }
              } else {
                console.log('未获取到最新价格，停止执行');
                return; // 直接停止，不再继续默认 last_updated_first 模式
              }
            } else {
              console.log('❌ 未在 K 线中找到匹配时间戳，停止添加流动性');
              return; // 停止添加流动性
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
      
      // 验证last_updated_first模式计算出的minBinId
      const validationResult = validateMinBinId(minBinId, 'last_updated_first');
      if (!validationResult.shouldContinue) {
        if (validationResult.shouldRetry) {
          startParallelRetry(POOL_ADDRESS.toString());
        }
        return; // 退出程序
      }
    }
    
    // 验证activeId是否大于或等于maxBinId（在所有bin范围计算完成后）
    const finalActiveId = dlmmPool.lbPair.activeId;
    if (finalActiveId < maxBinId) {
        throw new Error(`activeId (${finalActiveId}) 必须大于或等于 maxBinId (${maxBinId})`);
    }

    // 等待一段时间
    // console.log('等待 20 秒...');
    // await new Promise(resolve => setTimeout(resolve, 20000));

    // 优先复用已有 positionAddress；否则加锁创建一次并持久化
    const poolFile = path.resolve(__dirname, 'data', `${POOL_ADDRESS.toString()}.json`);
    const lockFile = path.resolve(__dirname, 'data', `${POOL_ADDRESS.toString()}.lock`);
    let existingPositionAddress: string | undefined;
    try {
      const raw = fs.readFileSync(poolFile, 'utf8');
      const json = JSON.parse(raw);
      if (json && typeof json.positionAddress === 'string' && json.positionAddress.trim().length > 0) {
        existingPositionAddress = json.positionAddress.trim();
      }
    } catch (e) {
      // 文件不存在或解析失败时忽略，按无地址处理
    }

    let positionPubKey: PublicKey | undefined;
    let createdNewPosition = false;
    let createTxHash: string | undefined;

    if (existingPositionAddress) {
      console.log(`🔁 复用已有仓位: ${existingPositionAddress}`);
      positionPubKey = new PublicKey(existingPositionAddress);
    } else {
      // 获取每池互斥锁
      const lockStart = Date.now();
      const lockTimeoutMs = 60000; // 最长等待60秒
      let hasLock = false;
      while (!hasLock) {
        try {
          const fd = fs.openSync(lockFile, 'wx');
          fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}`);
          fs.closeSync(fd);
          hasLock = true;
        } catch (_) {
          // 等待锁期间二次校验 JSON，若已有 positionAddress 则复用
          try {
            const raw2 = fs.readFileSync(poolFile, 'utf8');
            const json2 = JSON.parse(raw2);
            const addr2 = (json2 && typeof json2.positionAddress === 'string') ? json2.positionAddress.trim() : '';
            if (addr2) {
              console.log(`🔁 等锁期间检测到已有仓位，复用: ${addr2}`);
              positionPubKey = new PublicKey(addr2);
              break;
            }
          } catch (_) {}
          if (Date.now() - lockStart > lockTimeoutMs) {
            console.log('⚠️ 获取锁超时，继续执行创建流程');
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // 最终校验一次，避免并发重复创建
      if (!positionPubKey) {
        try {
          const raw3 = fs.readFileSync(poolFile, 'utf8');
          const json3 = JSON.parse(raw3);
          const addr3 = (json3 && typeof json3.positionAddress === 'string') ? json3.positionAddress.trim() : '';
          if (addr3) {
            console.log(`🔁 创建前最终校验命中已有仓位，复用: ${addr3}`);
            positionPubKey = new PublicKey(addr3);
          }
        } catch (_) {}
      }

      try {
        if (!positionPubKey) {
          console.log('🆕 未发现已有仓位，创建新的扩展空仓位...');
          const { transaction: createTransaction, positionKeypair } = await createExtendedEmptyPosition(
            dlmmPool,
            userKeypair.publicKey,
            minBinId,
            maxBinId
          );

          // 发送并确认创建仓位交易
          console.log('发送创建仓位交易...');
          createTransaction.sign(userKeypair as any, positionKeypair as any);
          const versionedCreateTransaction = new VersionedTransaction(createTransaction.compileMessage());
          versionedCreateTransaction.sign([userKeypair as any, positionKeypair as any]);
          createTxHash = await connection.sendTransaction(versionedCreateTransaction);
          console.log('创建交易哈希:', createTxHash);

          // 等待交易确认
          console.log('等待交易确认...');
          let confirmed = false;
          let attempts = 0;
          const maxAttempts = 30;
          while (!confirmed && attempts < maxAttempts) {
            const status = await connection.getSignatureStatus(createTxHash!, { searchTransactionHistory: true });
            if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
              confirmed = true;
              console.log('✅ 创建交易已确认');
            } else {
              console.log(`等待确认中... (${attempts + 1}/${maxAttempts})`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              attempts++;
            }
          }
          if (!confirmed) {
            throw new Error('创建交易确认超时');
          }

          // 提前持久化 positionAddress（创建确认后、加流动性前）
          positionPubKey = positionKeypair.publicKey;
          createdNewPosition = true;
          try {
            let jsonW: any = {};
            try {
              const rawW = fs.readFileSync(poolFile, 'utf8');
              jsonW = JSON.parse(rawW);
            } catch (e) { jsonW = {}; }
            const posAddr = positionPubKey.toString();
            jsonW.positionAddress = posAddr;
            if (jsonW.data && typeof jsonW.data === 'object') {
              jsonW.data.positionAddress = posAddr;
            }
            fs.writeFileSync(poolFile, JSON.stringify(jsonW, null, 2));
            console.log(`已写入 positionAddress 到 ${poolFile}（创建确认后、加流动性前）`);
          } catch (e: any) {
            console.log('写入 positionAddress 到 JSON 失败:', e?.message || String(e));
          }
        }
      } finally {
        // 释放锁
        try { fs.unlinkSync(lockFile); } catch (_) {}
      }
    }

    // 使用addLiquidityByStrategy添加流动性
    try {
      const strategy = {
        strategyType: STRATEGY_TYPE,
        minBinId: minBinId,
        maxBinId: maxBinId,
      };
      
      const addLiquidityTransaction = await dlmmPool.addLiquidityByStrategy({
        positionPubKey: positionPubKey!,
        totalXAmount: tokenXAmount,
        totalYAmount: tokenYAmount,
        strategy: strategy,
        user: userKeypair.publicKey,
        slippage: SLIPPAGE_FROM_ENV
      });
      
      // 发送并确认添加流动性交易
      console.log('发送添加流动性交易...');
      addLiquidityTransaction.sign(userKeypair as any);
      const versionedAddLiquidityTransaction = new VersionedTransaction(addLiquidityTransaction.compileMessage());
      versionedAddLiquidityTransaction.sign([userKeypair as any]);
      const addLiquidityTxHash = await connection.sendTransaction(versionedAddLiquidityTransaction);
      console.log('添加流动性交易哈希:', addLiquidityTxHash);
      
      // 等待交易确认（带重试和状态检查）
      console.log('等待添加流动性交易确认...');
      let addLiquidityConfirmed = false;
      let addLiquidityAttempts = 0;
      const maxAddLiquidityAttempts = 30;
      while (!addLiquidityConfirmed && addLiquidityAttempts < maxAddLiquidityAttempts) {
        const status = await connection.getSignatureStatus(addLiquidityTxHash, { searchTransactionHistory: true });
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
          // 检查交易是否成功（没有错误）
          if (status.value?.err === null) {
            addLiquidityConfirmed = true;
            console.log('✅ 添加流动性交易已确认并成功');
          } else {
            console.log('❌ 添加流动性交易失败:', status.value?.err);
            throw new Error(`添加流动性交易失败: ${JSON.stringify(status.value?.err)}`);
          }
        } else {
          console.log(`等待添加流动性确认中... (${addLiquidityAttempts + 1}/${maxAddLiquidityAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          addLiquidityAttempts++;
        }
      }
      if (!addLiquidityConfirmed) {
        throw new Error('添加流动性交易确认超时');
      }
      
      console.log('=== 交易完成 ===');
      console.log('仓位地址:', positionPubKey!.toString());
      if (createTxHash) {
        console.log('创建交易:', createTxHash);
      } else {
        console.log('创建交易: 复用已有仓位，未新建');
      }
      console.log('添加流动性交易:', addLiquidityTxHash);
      
      // 仅在创建新仓位时持久化 positionAddress
      if (createdNewPosition) {
        try {
          let json: any = {};
          try {
            const raw = fs.readFileSync(poolFile, 'utf8');
            json = JSON.parse(raw);
          } catch (e) {
            json = {};
          }
          const posAddr = positionPubKey!.toString();
          json.positionAddress = posAddr;
          if (json.data && typeof json.data === 'object') {
            json.data.positionAddress = posAddr;
          }
          fs.writeFileSync(poolFile, JSON.stringify(json, null, 2));
          console.log(`已写入 positionAddress 到 ${poolFile}`);
        } catch (e: any) {
          console.log('写入 positionAddress 到 JSON 失败:', e?.message || String(e));
        }
      }
      
    } catch (error) {
      console.log('❌ 添加流动性过程中发生错误:');
      console.log(JSON.stringify({
        addLiquidityByStrategy: {
          error: error instanceof Error ? error.message : String(error)
        }
      }, null, 2));
      
      // 如果添加流动性失败且创建了新仓位，尝试关闭空仓位
      if (createdNewPosition && positionPubKey) {
        console.log('🚨 添加流动性失败，尝试关闭刚创建的空仓位...');
        try {
          await closeEmptyPosition(dlmmPool, userKeypair, positionPubKey, minBinId, maxBinId);
          console.log('✅ 空仓位已关闭');
          
          // 清理JSON文件中的positionAddress，恢复到执行前状态
          try {
            let json: any = {};
            try {
              const raw = fs.readFileSync(poolFile, 'utf8');
              json = JSON.parse(raw);
            } catch (e) {
              json = {};
            }
            // 移除addLiquidity.ts添加的字段
            delete json.positionAddress;
            delete json.c;
            if (json.data && typeof json.data === 'object') {
              delete json.data.positionAddress;
              delete json.data.c;
            }
            fs.writeFileSync(poolFile, JSON.stringify(json, null, 2));
            console.log('✅ 已清理JSON文件中的positionAddress和c字段，恢复到执行前状态');
          } catch (cleanupError) {
            console.log('⚠️ 清理JSON文件失败:', cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          }
          
          // 等待区块链状态更新
          console.log('⏳ 等待3秒让区块链状态更新...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          console.log('✅ 等待完成，准备重新执行');
          
          // 重新执行整个addLiquidity流程
          console.log('🔄 重新执行addLiquidity.ts...');
          await main();
          
        } catch (closeError) {
          console.error('❌ 关闭空仓位失败:', closeError instanceof Error ? closeError.message : String(closeError));
          console.log('⚠️ 请手动检查并关闭仓位:', positionPubKey.toString());
        }
      } else if (positionPubKey) {
        console.log('⚠️ 添加流动性失败，但未创建新仓位，请检查仓位状态:', positionPubKey.toString());
      }
      
      // 重新抛出错误，让上层知道执行失败
      throw error;
    }

    
  } catch (error) {
    console.error('错误:', error);
  }
}

/**
 * 关闭空仓位
 */
async function closeEmptyPosition(
  dlmmPool: any,
  userKeypair: Keypair,
  positionPubKey: PublicKey,
  minBinId: number,
  maxBinId: number
): Promise<void> {
  try {
    console.log('🔧 尝试关闭空仓位...');
    
    // 获取仓位对象
    const position = await dlmmPool.getPosition(positionPubKey);
    
    // 使用 closePositionIfEmpty 方法关闭空仓位
    const closeTransaction = await dlmmPool.closePositionIfEmpty({
      owner: userKeypair.publicKey,
      position: position
    });
    
    console.log('生成了关闭空仓位交易');
    
    // 执行交易
    console.log('执行关闭仓位交易...');
    closeTransaction.sign(userKeypair as any);
    const versionedTransaction = new VersionedTransaction(closeTransaction.compileMessage());
    versionedTransaction.sign([userKeypair as any]);
    
    const txHash = await connection.sendTransaction(versionedTransaction);
    console.log('关闭仓位交易哈希:', txHash);
    
    await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
    console.log('关闭仓位交易已确认');
    
    console.log('✅ 空仓位关闭完成');
  } catch (error) {
    console.error('❌ 关闭空仓位失败:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}


// 导出函数供其他模块使用
export {
  createExtendedEmptyPosition,
  addLiquidityWithExtendedPosition,
  completeSpotStrategyFlow,
  closeEmptyPosition,
  main
};

// 如果直接运行此文件，则执行main函数
if (require.main === module) {
  main();
}
