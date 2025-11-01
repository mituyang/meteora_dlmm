import { 
  Connection, 
  PublicKey, 
  clusterApiUrl
} from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import * as dotenv from 'dotenv';
import * as CryptoJS from 'crypto-js';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

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

// 全局日志前缀注入：[YYYY-MM-DD HH:mm:ss][fetchPrice]
(function setupPrefixedLogger() {
  const FILE_TAG = 'fetchPrice';
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

// ===== 价格缓存（跨进程、基于文件）=====
const PRICE_CACHE_DIR = '/Users/yqw/meteora_dlmm/data/prices';

interface PriceCacheEntry {
  price: string;           // 原样字符串
  timestamp: number;       // ms since epoch
}

function ensurePriceCacheDir() {
  try {
    if (!fs.existsSync(PRICE_CACHE_DIR)) {
      fs.mkdirSync(PRICE_CACHE_DIR, { recursive: true });
    }
  } catch (_) {}
}

function getPriceCachePath(tokenContractAddress: string): string {
  return path.join(PRICE_CACHE_DIR, `${tokenContractAddress}.json`);
}

function readCachedPrice(tokenContractAddress: string): PriceCacheEntry | null {
  try {
    ensurePriceCacheDir();
    const p = getPriceCachePath(tokenContractAddress);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.price !== 'string' || typeof obj.timestamp !== 'number') return null;
    return { price: obj.price, timestamp: obj.timestamp };
  } catch (_) {
    return null;
  }
}

function writeCachedPrice(tokenContractAddress: string, price: string): void {
  try {
    ensurePriceCacheDir();
    const p = getPriceCachePath(tokenContractAddress);
    const entry: PriceCacheEntry = { price, timestamp: Date.now() };
    fs.writeFileSync(p, JSON.stringify(entry));
  } catch (_) {}
}

// 价格监控状态管理
interface PriceMonitorState {
  isMonitoring: boolean;
  startTime: number;
  lastCheckTime: number;
  initialThreshold: number; // c * targetValue (从环境变量获取)
  targetThreshold: number;  // c * targetValue * 1.2 止损阈值：价格回升20%时止损移除流动性
  poolAddress: string;
  positionAddress: string;
  c: number;
}

// 监控状态文件路径
const PRICE_MONITOR_STATES_FILE = path.join('/Users/yqw/meteora_dlmm/data/states', '.priceMonitorStates.json');

// 从文件加载监控状态
function loadPriceMonitorStates(): Map<string, PriceMonitorState> {
  try {
    if (!fs.existsSync(PRICE_MONITOR_STATES_FILE)) {
      return new Map();
    }
    const raw = fs.readFileSync(PRICE_MONITOR_STATES_FILE, 'utf8');
    const data = JSON.parse(raw);
    const states = new Map<string, PriceMonitorState>();
    for (const [key, value] of Object.entries(data)) {
      states.set(key, value as PriceMonitorState);
    }
    return states;
  } catch (_) {
    return new Map();
  }
}

// 保存监控状态到文件
function savePriceMonitorStates(states: Map<string, PriceMonitorState>): void {
  try {
    const data: Record<string, PriceMonitorState> = {};
    for (const [key, value] of states.entries()) {
      data[key] = value;
    }
    fs.writeFileSync(PRICE_MONITOR_STATES_FILE, JSON.stringify(data, null, 2));
  } catch (_) {
    // 忽略写入错误
  }
}

// 全局监控状态存储（从文件加载）
const priceMonitorStates = loadPriceMonitorStates();

// ===== 仓位X为0的连续监控（每池）=====
interface ZeroXMonitorState {
  zeroSince: number | null;   // 开始为0的时间戳(ms)
}

const ZERO_X_STATES_FILE = path.join('/Users/yqw/meteora_dlmm/data/states', '.zeroXStates.json');

// 从文件加载状态
function loadZeroXStates(): Map<string, ZeroXMonitorState> {
  try {
    if (!fs.existsSync(ZERO_X_STATES_FILE)) {
      return new Map();
    }
    const raw = fs.readFileSync(ZERO_X_STATES_FILE, 'utf8');
    const data = JSON.parse(raw);
    const states = new Map<string, ZeroXMonitorState>();
    for (const [key, value] of Object.entries(data)) {
      states.set(key, value as ZeroXMonitorState);
    }
    return states;
  } catch (_) {
    return new Map();
  }
}

// 保存状态到文件
function saveZeroXStates(states: Map<string, ZeroXMonitorState>): void {
  try {
    const data: Record<string, ZeroXMonitorState> = {};
    for (const [key, value] of states.entries()) {
      data[key] = value;
    }
    fs.writeFileSync(ZERO_X_STATES_FILE, JSON.stringify(data, null, 2));
  } catch (_) {
    // 忽略写入错误
  }
}

const zeroXStates = loadZeroXStates();

function getZeroXState(poolAddress: string): ZeroXMonitorState {
  let st = zeroXStates.get(poolAddress);
  if (!st) {
    st = { zeroSince: null };
    zeroXStates.set(poolAddress, st);
    saveZeroXStates(zeroXStates);
  }
  return st;
}

function clearZeroXState(poolAddress: string): void {
  zeroXStates.delete(poolAddress);
  saveZeroXStates(zeroXStates);
}

async function getPositionTotalXAmount(poolAddress: string, positionAddress: string): Promise<bigint | null> {
  try {
    console.log(`🔎 准备读取仓位X数量: pool=${poolAddress}, position=${positionAddress}`);
    const poolPubKey = new PublicKey(poolAddress);
    const positionPubKey = new PublicKey(positionAddress);
    const dlmmPool = await withRetry(() => DLMM.create(connection, poolPubKey), 'DLMM池实例创建');
    const position = await withRetry(() => dlmmPool.getPosition(positionPubKey), '仓位对象获取');
    // position.positionData.totalXAmount 可能是 BN-like，转为字符串再到 BigInt
    const raw: any = position.positionData.totalXAmount;
    const v = typeof raw === 'string' ? BigInt(raw) : BigInt(raw.toString());
    console.log(`📦 当前仓位X数量(最小单位): ${v.toString()}`);
    return v;
  } catch (e) {
    console.error('❌ 获取仓位X数量失败:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function checkZeroXAndMaybeRemove(poolAddress: string, positionAddress: string): Promise<void> {
  const amount = await getPositionTotalXAmount(poolAddress, positionAddress);
  if (amount === null) {
    console.log('⚠️ 本次未能获取到仓位X数量，跳过连续为0检查');
    return;
  }

  const st = getZeroXState(poolAddress);
  const now = Date.now();

  if (amount === 0n) {
    if (st.zeroSince === null) {
      st.zeroSince = now;
      saveZeroXStates(zeroXStates);
      console.log(`🧪 发现X为0，开始计时: pool=${poolAddress}，连续第1分钟`);
    } else {
      const mins = (now - st.zeroSince) / (1000 * 60);
      const consecutive = Math.floor(mins) + 1; // 连续第N分钟（首分钟记为1）
      console.log(`🧪 X为0，连续第${consecutive}分钟`);
      if (mins >= 29) {
        console.log('⛔ X为0已持续29分钟，执行移除流动性');
        await executeRemoveLiquidity(poolAddress, positionAddress, 'X为0持续29分钟');
        clearZeroXState(poolAddress);
      }
    }
  } else {
    if (st.zeroSince !== null) {
      console.log('✅ X不为0，清除计时');
    }
    clearZeroXState(poolAddress);
  }
}

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
async function executeRemoveLiquidity(poolAddress: string, positionAddress: string, reason: string): Promise<void> {
  try {
    console.log(`🚨 ${reason}，开始移除流动性...`);
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
    
    // 移除流动性后，清除监控状态
    priceMonitorStates.delete(poolAddress);
    savePriceMonitorStates(priceMonitorStates); // 保存到文件
    console.log(`🧹 已清除池 ${poolAddress} 的监控状态`);
  } catch (error) {
    console.error('❌ 移除流动性操作失败:', error);
  }
}

/**
 * 开始价格监控
 */
function startPriceMonitoring(poolAddress: string, positionAddress: string, c: number): void {
  const now = Date.now();
  // 从环境变量获取目标值，默认为0.4
  const targetValue = process.env.TARGET_VALUE ? parseFloat(process.env.TARGET_VALUE) : 0.4;
  const initialThreshold = c * (targetValue + 0.01);
  const targetThreshold = c * targetValue * 1.2; // 止损阈值：价格回升20%时止损移除流动性
  
  const monitorState: PriceMonitorState = {
    isMonitoring: true,
    startTime: now,
    lastCheckTime: now,
    initialThreshold,
    targetThreshold,
    poolAddress,
    positionAddress,
    c
  };
  
  priceMonitorStates.set(poolAddress, monitorState);
  savePriceMonitorStates(priceMonitorStates); // 保存到文件
  
  console.log(`🔍 开始监控池 ${poolAddress} 的价格变化`);
  console.log(`   初始阈值 (c * (${targetValue} + 0.01)): ${initialThreshold}`);
  console.log(`   止损阈值 (c * ${targetValue} * 1.2): ${targetThreshold}`);
  console.log(`   监控开始时间: ${new Date(now).toLocaleString()}`);
}

/**
 * 检查价格监控状态
 */
async function checkPriceMonitoring(poolAddress: string, currentPrice: number): Promise<boolean> {
  const monitorState = priceMonitorStates.get(poolAddress);
  if (!monitorState || !monitorState.isMonitoring) {
    return false;
  }
  
  const now = Date.now();
  const elapsedMinutes = (now - monitorState.startTime) / (1000 * 60);
  
  console.log(`📊 监控检查 - 池: ${poolAddress}`);
  console.log(`   当前价格: ${currentPrice}`);
  console.log(`   止损阈值: ${monitorState.targetThreshold}`);
  console.log(`   已监控时长: ${elapsedMinutes.toFixed(1)} 分钟`);
  
  // 检查是否达到目标阈值
  if (currentPrice >= monitorState.targetThreshold) {
    console.log(`✅ 价格已回升至止损阈值，执行止损移除流动性`);
    await executeRemoveLiquidity(poolAddress, monitorState.positionAddress, '价格回升至止损阈值');
    return true;
  }
  
  // 检查是否超过10分钟
  if (elapsedMinutes >= 8) {
    console.log(`⏰ 监控已超过8分钟，强制执行移除流动性`);
    await executeRemoveLiquidity(poolAddress, monitorState.positionAddress, '监控超时');
    return true;
  }
  
  // 更新最后检查时间
  monitorState.lastCheckTime = now;
  priceMonitorStates.set(poolAddress, monitorState);
  savePriceMonitorStates(priceMonitorStates); // 保存到文件
  
  console.log(`⏳ 继续监控，下次检查将在1分钟后`);
  return false;
}

/**
 * 获取所有正在监控的池地址
 */
function getMonitoringPoolAddresses(): string[] {
  return Array.from(priceMonitorStates.keys()).filter(poolAddress => {
    const state = priceMonitorStates.get(poolAddress);
    return state && state.isMonitoring;
  });
}

/**
 * 清除过期的监控状态（超过24小时的监控状态）
 */
function clearExpiredMonitorStates(): void {
  const now = Date.now();
  const expiredPools: string[] = [];
  
  for (const [poolAddress, state] of priceMonitorStates.entries()) {
    const elapsedHours = (now - state.startTime) / (1000 * 60 * 60);
    if (elapsedHours > 24) {
      expiredPools.push(poolAddress);
    }
  }
  
  for (const poolAddress of expiredPools) {
    priceMonitorStates.delete(poolAddress);
    console.log(`🧹 清除过期监控状态: ${poolAddress}`);
  }
  
  if (expiredPools.length > 0) {
    savePriceMonitorStates(priceMonitorStates);
  }
}

/**
 * 获取 OKX DEX 最新价格（通过 K 线数据）
 * GET /api/v6/dex/market/historical-candles
 * 获取最新的 K 线数据，使用开盘价 o 作为价格
 */
export async function fetchOkxLatestPrice(tokenContractAddress: string): Promise<string | undefined> {
  // 先尝试读取同一分钟内的缓存
  const cached = readCachedPrice(tokenContractAddress);
  if (cached) {
    const now = Date.now();
    // 同一分钟：取整到分钟比较（01秒由 main.go 调度）
    const sameMinute = Math.floor(now / 60000) === Math.floor(cached.timestamp / 60000);
    if (sameMinute) {
      console.log('🗄️ 使用缓存价格(同一分钟):', cached.price);
      return cached.price;
    }
  }

  try {
    const data = await withRetry(() => fetchOkxCandles(tokenContractAddress), 'OKX K线数据获取');
    
    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      console.log('OKX K线响应为空或无数据');
      return undefined;
    }

    // 获取最新的 K 线数据（数组第一个元素是最新的）
    const latestCandle = data.data[0];
    if (!latestCandle || !Array.isArray(latestCandle) || latestCandle.length < 2) {
      console.log('OKX K线响应中未找到有效的K线数据，原始响应:', JSON.stringify(data));
      return undefined;
    }

    // 根据文档，数组格式为：[ts,o,h,l,c,vol,volUsd,confirm]
    // o 是开盘价，位于索引1
    const priceStr = String(latestCandle[1]);
    // 成功获取后写入缓存
    writeCachedPrice(tokenContractAddress, priceStr);
    return priceStr;
  } catch (error) {
    console.log('获取 OKX K线数据失败:', error);
    return undefined;
  }
}

/**
 * 从 OKX DEX 获取指定 token 的 1m K线数据
 * 固定参数：chainIndex=501, bar=1m, limit=10
 * 其余参数（after/before）保留为空
 */
async function fetchOkxCandles(tokenContractAddress: string, after?: string, before?: string): Promise<any> {
  const baseUrl = 'https://web3.okx.com/api/v6/dex/market/historical-candles';
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

  return data;
}

/**
 * 主函数 - 获取价格并进行比较
 */
async function main() {
  try {
    // 清除过期的监控状态
    clearExpiredMonitorStates();
    
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
    const latestPrice = await withRetry(() => fetchOkxLatestPrice(tokenAddress), 'OKX最新价格获取');
    if (latestPrice !== undefined) {
      console.log('OKX DEX 最新价格:', latestPrice);
      console.log('price:', latestPrice); // 专门输出price字段，供main.go解析
      
      // 读取池数据进行比较
      const poolData = await readPoolDataFromJSON(poolAddress);
      if (poolData) {
        const currentPrice = parseFloat(latestPrice);
        // 从环境变量获取目标值，默认为0.4
        const targetValue = process.env.TARGET_VALUE ? parseFloat(process.env.TARGET_VALUE) : 0.4;
        const initialThreshold = poolData.c * (targetValue + 0.01);
        const targetThreshold = poolData.c * targetValue * 1.2; // 止损阈值：价格回升20%时止损移除流动性
        
        console.log(`📊 价格比较:`);
        console.log(`  当前价格: ${currentPrice}`);
        console.log(`  初始阈值 (c * (${targetValue} + 0.01)): ${initialThreshold}`);
        console.log(`  止损阈值 (c * ${targetValue} * 1.2): ${targetThreshold}`);
        console.log(`  c 值: ${poolData.c}`);
        
        // 检查是否已经在监控中
        const existingState = priceMonitorStates.get(poolAddress);
        const isMonitoring = existingState && existingState.isMonitoring;
        
        if (isMonitoring) {
          // 如果已经在监控中，检查监控状态
          console.log(`🔍 池 ${poolAddress} 正在监控中，检查价格变化...`);
          const shouldStop = await checkPriceMonitoring(poolAddress, currentPrice);
          if (shouldStop) {
            // 监控已结束（触发移除流动性或超时），清除状态
            priceMonitorStates.delete(poolAddress);
            savePriceMonitorStates(priceMonitorStates);
          }
        } else if (currentPrice < initialThreshold) {
          // 如果价格低于初始阈值且未在监控，开始监控
          console.log(`⚠️  当前价格 ${currentPrice} 低于初始阈值 ${initialThreshold}，开始价格监控`);
          startPriceMonitoring(poolAddress, poolData.positionAddress, poolData.c);
        } else {
          console.log(`✅ 当前价格 ${currentPrice} 高于初始阈值 ${initialThreshold}，无需操作`);
        }

        // 无论是否监控价格，都检查仓位X是否连续为0
        await checkZeroXAndMaybeRemove(poolAddress, poolData.positionAddress);
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

// 导出函数供其他模块使用
export { getMonitoringPoolAddresses, checkPriceMonitoring };

// 如果直接运行此文件，则执行main函数
if (require.main === module) {
  main();
}
