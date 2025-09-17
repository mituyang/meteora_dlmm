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
 * 移除流动性的基本用法
 */
async function removeLiquidity() {
  try {
    // 1. 创建DLMM池实例
    const poolAddress = new PublicKey(process.env.POOL_ADDRESS!);
    const dlmmPool = await DLMM.create(connection, poolAddress);
    
    // 2. 仓位信息
    const positionPubKey = new PublicKey(process.env.POSITION_ADDRESS!);
    
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
    console.log('池地址:', poolAddress.toString());
    console.log('Bin范围:', `${lowerBinId} - ${upperBinId}`);
    
    // 5. 调用removeLiquidity方法 - 默认移除所有流动性
    const transactions = await dlmmPool.removeLiquidity({
      user: new PublicKey(process.env.USER_WALLET_ADDRESS!),  // 用户公钥 (从.env读取)
      position: positionPubKey,              // 仓位公钥
      fromBinId: lowerBinId,                 // 下限bin ID
      toBinId: upperBinId,                   // 上限bin ID
      bps: new BN(10000),                    // 移除100%流动性 (10000 BPS = 100%) - 默认移除所有流动性
      shouldClaimAndClose: true,             // 领取奖励并关闭仓位 - 默认true
      skipUnwrapSOL: false                   // 不解包SOL - 默认false
    });
    
    console.log(`生成了 ${transactions.length} 个交易`);
    
    // 6. 执行交易
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      console.log(`执行交易 ${i + 1}/${transactions.length}...`);
      
      // 签名并发送交易
      transaction.sign(userKeypair as any);
      const versionedTransaction = new VersionedTransaction(transaction.compileMessage());
      versionedTransaction.sign([userKeypair as any]);
      
      const txHash = await connection.sendTransaction(versionedTransaction);
      console.log(`交易 ${i + 1} 哈希:`, txHash);
      
      // 等待确认
      await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
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