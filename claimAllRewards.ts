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
import fs from 'fs';
import path from 'path';

// 加载环境变量
dotenv.config();

// 连接配置
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

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
    console.log('仓位地址:', positionPubKey.toString(), cliPosition ? '(来自命令行)' : '(来自环境变量)');
    console.log('池地址:', poolAddress.toString(), cliPool ? '(来自命令行)' : '(来自环境变量)');

    // 4. 构建领取交易（可能返回多笔）
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

    // 5. 依次签名并发送
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
  } catch (error) {
    console.error('错误:', error instanceof Error ? error.message : String(error));
  }
}

// 运行
if (require.main === module) {
  claimAllRewardsByPosition();
}

export { claimAllRewardsByPosition };


