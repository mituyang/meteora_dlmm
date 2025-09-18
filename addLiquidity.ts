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

// 加载环境变量
dotenv.config();

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 从命令行与环境变量读取配置（命令行优先）
const argv = process.argv.slice(2);
function resolvePoolAddressFromArgs(): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--pool=')) return arg.split('=')[1];
  }
  return undefined;
}

function resolveTokenAddressFromArgs(): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--token-address=')) return arg.split('=')[1];
    if (arg.startsWith('--token=')) return arg.split('=')[1];
  }
  return undefined;
}

const USER_WALLET_ADDRESS = new PublicKey(process.env.USER_WALLET_ADDRESS!);

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
  
  // 返回向上取整的整数
  return Math.ceil(leftBins);
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
async function fetchOkxCandles(tokenContractAddress: string, after?: string, before?: string): Promise<void> {
  const baseUrl = 'https://web3.okx.com/api/v5/dex/market/candles';
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

  console.log('OKX DEX 1m K线（limit=10）响应:');
  console.log(JSON.stringify(data, null, 2));
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

  const resp = await axios.post(url, bodyArray, { headers });
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
    console.log('📊 模式: 自动计算Bin ID');
    
    // 解析POOL_ADDRESS（命令行优先，其次.env）
    const cliPoolAddress = resolvePoolAddressFromArgs();
    const poolAddressStr = cliPoolAddress || process.env.POOL_ADDRESS;
    if (!poolAddressStr) {
      throw new Error('缺少必需的POOL_ADDRESS，请通过 --pool=  传入，或在.env中设置');
    }
    const POOL_ADDRESS = new PublicKey(poolAddressStr);
    console.log(`使用的POOL_ADDRESS: ${POOL_ADDRESS.toString()}${cliPoolAddress ? ' (来自命令行)' : ' (来自.env)'}`);
    
    // 创建DLMM池实例
    const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);
    
    // 获取当前活跃Bin ID
    const activeId = dlmmPool.lbPair.activeId;
    
    // 单边池参数 - tokenXAmount为0，只提供tokenY
    const tokenXAmount = new BN(0); // 单边池，Token X 数量为0
    
    // 从环境变量读取SOL数量
    const solAmount = parseFloat(process.env.SOL_AMOUNT!);
    const tokenYAmount = new BN(solAmount * 10 ** TOKEN_Y_DECIMAL); // SOL数量乘以精度
    
    // 计算Bin ID范围（仅自动模式）
    let minBinId: number;
    let maxBinId: number;
    const binStep = dlmmPool.lbPair.binStep;
    const leftBins = calculateDynamicLeftBins(binStep);
    maxBinId = activeId - 1;  // activeId-1为maxBinId
    minBinId = activeId - leftBins;  // activeId-leftBins为minBinId
    console.log(`🔢 自动计算Bin ID范围:`);
    console.log(`- Active ID: ${activeId}`);
    console.log(`- Bin Step: ${binStep} (从池中获取)`);
    console.log(`- 左侧Bins数量: ${leftBins}`);
    console.log(`- Min Bin ID: ${minBinId}`);
    console.log(`- Max Bin ID: ${maxBinId}`);
    console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
    
    // 验证activeId是否大于或等于maxBinId
    if (activeId < maxBinId) {
        throw new Error(`activeId (${activeId}) 必须大于或等于 maxBinId (${maxBinId})`);
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
    
    // 获取 OKX DEX K线
    const tokenFromCli = resolveTokenAddressFromArgs();
    if (tokenFromCli) {
      // 先尝试获取最新价格（不阻塞 K 线）
      try {
        const latestPrice = await fetchOkxLatestPrice(tokenFromCli);
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
        await fetchOkxCandles(tokenFromCli);
      } catch (e) {
        console.log('获取 OKX DEX K线失败:', e instanceof Error ? e.message : String(e));
      }
    } else {
      console.log('未提供 tokenContractAddress（--token= 或 --token-address=），跳过 OKX DEX K线获取');
    }

    // 等待一段时间
    console.log('等待 20 秒...');
    await new Promise(resolve => setTimeout(resolve, 20000));

    // 使用createExtendedEmptyPosition创建大范围仓位
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
    const createTxHash = await connection.sendTransaction(versionedCreateTransaction);
    console.log('创建交易哈希:', createTxHash);
    
    // 等待交易确认
    console.log('等待交易确认...');
    let confirmed = false;
    let attempts = 0;
    const maxAttempts = 30; // 最多等待30秒
    
    while (!confirmed && attempts < maxAttempts) {
      try {
        const status = await connection.getSignatureStatus(createTxHash, { searchTransactionHistory: true });
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
      
      const addLiquidityTransaction = await dlmmPool.addLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        totalXAmount: tokenXAmount,
        totalYAmount: tokenYAmount,
        strategy: strategy,
        user: userKeypair.publicKey,
        slippage: 0.1
      });
      
      // 发送并确认添加流动性交易
      console.log('发送添加流动性交易...');
      addLiquidityTransaction.sign(userKeypair as any);
      const versionedAddLiquidityTransaction = new VersionedTransaction(addLiquidityTransaction.compileMessage());
      versionedAddLiquidityTransaction.sign([userKeypair as any]);
      const addLiquidityTxHash = await connection.sendTransaction(versionedAddLiquidityTransaction);
      console.log('添加流动性交易哈希:', addLiquidityTxHash);
      
      // 等待交易确认
      await connection.getSignatureStatus(addLiquidityTxHash, { searchTransactionHistory: true });
      console.log('添加流动性交易已确认');
      
      console.log('=== 交易完成 ===');
      console.log('仓位地址:', positionKeypair.publicKey.toString());
      console.log('创建交易:', createTxHash);
      console.log('添加流动性交易:', addLiquidityTxHash);
      
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
