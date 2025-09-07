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

// 加载环境变量
dotenv.config();

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 从环境变量读取配置
const POOL_ADDRESS = new PublicKey(process.env.POOL_ADDRESS!);
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

// 移除JSON保存功能，只保留原始数据

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
    // 检查是否启用自动模式
    const autoMode = process.env.AUTO_BIN_CALCULATION === 'true';
    
    // 验证必需的环境变量
    const requiredEnvVars = [
      'PRIVATE_KEY',
      'POOL_ADDRESS', 
      'USER_WALLET_ADDRESS',
      'SOL_AMOUNT'
    ];
    
    // 根据模式添加不同的必需变量
    if (!autoMode) {
      requiredEnvVars.push('MIN_BIN_ID', 'MAX_BIN_ID');
    }
    
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`缺少必需的环境变量: ${envVar}`);
      }
    }
    
    console.log('✅ 所有环境变量配置完成');
    console.log(`📊 模式: ${autoMode ? '自动计算Bin ID' : '手动设置Bin ID'}`);
    
    // 创建DLMM池实例
    const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);
    
    // 获取当前活跃Bin ID
    const activeId = dlmmPool.lbPair.activeId;
    
    // 单边池参数 - tokenXAmount为0，只提供tokenY
    const tokenXAmount = new BN(0); // 单边池，Token X 数量为0
    
    // 从环境变量读取SOL数量
    const solAmount = parseFloat(process.env.SOL_AMOUNT!);
    const tokenYAmount = new BN(solAmount * 10 ** TOKEN_Y_DECIMAL); // SOL数量乘以精度
    
    // 计算Bin ID范围
    let minBinId: number;
    let maxBinId: number;
    
    if (autoMode) {
      // 自动模式：基于activeId和池的bin_step计算
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
    } else {
      // 手动模式：从环境变量读取
      minBinId = parseInt(process.env.MIN_BIN_ID!);
      maxBinId = parseInt(process.env.MAX_BIN_ID!);
      
      console.log(`🔢 手动设置Bin ID范围:`);
      console.log(`- Active ID: ${activeId}`);
      console.log(`- Min Bin ID: ${minBinId}`);
      console.log(`- Max Bin ID: ${maxBinId}`);
      console.log(`- 总Bins数量: ${maxBinId - minBinId + 1}`);
    }
    
    // 验证activeId是否大于或等于maxBinId
    if (activeId < maxBinId) {
        throw new Error(`activeId (${activeId}) 必须大于或等于 maxBinId (${maxBinId})`);
    } 
    
    // 创建用户密钥对
    let userKeypair: Keypair;
    
    // 从环境变量读取私钥
    if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY !== 'your_private_key_here') {
      try {
        // 尝试Base58格式的私钥
        userKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        console.log('✅ 从环境变量加载钱包 (Base58格式)');
      } catch (base58Error) {
        try {
          // 尝试数组格式的私钥
          userKeypair = Keypair.fromSecretKey(
            new Uint8Array(JSON.parse(`[${process.env.PRIVATE_KEY}]`))
          );
          console.log('✅ 从环境变量加载钱包 (数组格式)');
        } catch (arrayError) {
          console.log('❌ 环境变量私钥格式错误');
          console.log('支持的格式：Base58字符串 或 逗号分隔的数字数组');
          throw new Error('私钥格式错误，请检查.env文件中的PRIVATE_KEY');
        }
      }
    } else {
      console.log('❌ 未找到私钥配置');
      console.log('请在.env文件中设置PRIVATE_KEY');
      throw new Error('未配置私钥，请在.env文件中设置PRIVATE_KEY');
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
    
    // 使用createExtendedEmptyPosition创建大范围仓位
    const { transaction: createTransaction, positionKeypair } = await createExtendedEmptyPosition(
      dlmmPool,
      userKeypair.publicKey,
      minBinId,
      maxBinId
    );
    
    // 输出createExtendedEmptyPosition原始数据
    console.log(JSON.stringify({
      createExtendedEmptyPosition: {
        transaction: {
          instructions: createTransaction.instructions.map((ix: any) => ({
            programId: ix.programId.toString(),
            keys: ix.keys.map((key: any) => ({
              pubkey: key.pubkey.toString(),
              isSigner: key.isSigner,
              isWritable: key.isWritable
            })),
            data: ix.data.toString('base64')
          })),
          feePayer: createTransaction.feePayer?.toString(),
          recentBlockhash: createTransaction.recentBlockhash
        },
        positionKeypair: {
          publicKey: positionKeypair.publicKey.toString(),
          secretKey: Array.from(positionKeypair.secretKey)
        }
      }
    }, null, 2));
    
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
      
      // 输出addLiquidityByStrategy原始数据
      console.log(JSON.stringify({
        addLiquidityByStrategy: {
          transaction: {
            instructions: addLiquidityTransaction.instructions.map((ix: any) => ({
              programId: ix.programId.toString(),
              keys: ix.keys.map((key: any) => ({
                pubkey: key.pubkey.toString(),
                isSigner: key.isSigner,
                isWritable: key.isWritable
              })),
              data: ix.data.toString('base64')
            })),
            feePayer: addLiquidityTransaction.feePayer?.toString(),
            recentBlockhash: addLiquidityTransaction.recentBlockhash
          }
        }
      }, null, 2));
      
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
