import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction,
  clusterApiUrl
} from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 用户指定的池地址
const POOL_ADDRESS = new PublicKey('6XMrsTeFC8gYmVasKaBuVwU4fyAVPJLHd8jno82JBhS5');

// 用户指定的钱包地址
const USER_WALLET_ADDRESS = new PublicKey('F7vnfsoWYR3XQdPcDtRfLQv9KmQvsgXsV3xfRSHCRHT7');

// 代币精度
const TOKEN_Y_DECIMAL = 9;  //sol

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
  const createTxHash = await connection.sendTransaction(createTransaction, [positionKeypair]);
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
  const addLiquidityTxHash = await connection.sendTransaction(addLiquidityTransaction, [userKeypair]);
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
    // 创建DLMM池实例
    const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);
    
    // 获取当前活跃Bin ID
    const activeId = dlmmPool.lbPair.activeId;
    
    // 单边池参数 - tokenXAmount为0，只提供tokenY
    const tokenXAmount = new BN(0); // 单边池，Token X 数量为0
    const tokenYAmount = new BN(1).mul(new BN(10 ** TOKEN_Y_DECIMAL)); // 1 Token Y
    
    // 用户指定的Bin ID范围
    const minBinId = 1600;
    const maxBinId = 1700;
    
    // 验证activeId是否大于或等于maxBinId
    if (activeId < maxBinId) {
        throw new Error(`activeId (${activeId}) 必须大于或等于 maxBinId (${maxBinId})`);
    } 
    
    // 创建用户密钥对（实际使用时应该从钱包导入）
    const userKeypair = new Keypair();
    
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
    
    // 注意：这里不发送交易，只获取原始数据
    // 实际使用时需要先发送并确认创建仓位交易，然后再调用addLiquidityByStrategy
    
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
