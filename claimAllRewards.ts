import { 
  Connection, 
  PublicKey, 
  Keypair, 
  VersionedTransaction,
  clusterApiUrl
} from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
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
 * 最基本的按仓位领取（Swap Fee + LM 奖励，若有其一即可）
 */
async function claimAllRewardsByPosition() {
  try {
    // 1. 实例化 DLMM 池
    const poolAddress = new PublicKey(process.env.POOL_ADDRESS!);
    const dlmmPool = await DLMM.create(connection, poolAddress);

    // 2. 加载仓位（LbPosition）
    const positionPubKey = new PublicKey(process.env.POSITION_ADDRESS!);
    const position = await dlmmPool.getPosition(positionPubKey);

    // 3. 准备用户密钥对
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
    console.log('仓位地址:', positionPubKey.toString());
    console.log('池地址:', poolAddress.toString());

    // 4. 构建领取交易（可能返回多笔）
    const transactions = await dlmmPool.claimAllRewardsByPosition({ owner, position });

    if (transactions.length === 0) {
      console.log('没有可领取的手续费或奖励');
      return;
    }

    console.log(`生成了 ${transactions.length} 个交易`);

    // 5. 依次签名并发送
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      console.log(`执行交易 ${i + 1}/${transactions.length}...`);

      transaction.sign(userKeypair as any);
      const versionedTransaction = new VersionedTransaction(transaction.compileMessage());
      versionedTransaction.sign([userKeypair as any]);

      const txHash = await connection.sendTransaction(versionedTransaction);
      console.log(`交易 ${i + 1} 哈希:`, txHash);

      await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
      console.log(`交易 ${i + 1} 已确认`);
    }

    console.log('✅ 领取完成');
  } catch (error) {
    console.error('错误:', error instanceof Error ? error.message : String(error));
  }
}

// 运行
if (require.main === module) {
  claimAllRewardsByPosition();
}

export { claimAllRewardsByPosition };


