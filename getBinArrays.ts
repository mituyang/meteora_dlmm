import { Connection, PublicKey } from '@solana/web3.js';
import DLMM, { getPriceOfBinByBinId } from '@meteora-ag/dlmm';
import { Decimal } from 'decimal.js';
import * as fs from 'fs';

// 分析bin数据的函数
function analyzeBinData(outputData: any): {isComplete: boolean, minToActiveComplete: boolean} {
  console.log('\n=== Bin数据分析 ===');
  
  // 收集所有bin数据
  const allBins: Array<{binId: number, actualPrice: string}> = [];
  
  for (const binArray of outputData.binArrays) {
    for (const bin of binArray.bins) {
      allBins.push({
        binId: bin.binId,
        actualPrice: bin.actualPrice
      });
    }
  }
  
  if (allBins.length === 0) {
    console.log('没有找到任何bin数据');
    return {isComplete: false, minToActiveComplete: false};
  }
  
  // 按binId排序
  allBins.sort((a, b) => a.binId - b.binId);
  
  // 找到最小和最大的binId
  const minBin = allBins[0];
  const maxBin = allBins[allBins.length - 1];
  const activeId = parseInt(outputData.activeId);
  
  console.log(`最小binId: ${minBin.binId}, actualPrice: ${minBin.actualPrice}`);
  console.log(`最大binId: ${maxBin.binId}, actualPrice: ${maxBin.actualPrice}`);
  console.log(`activeId: ${activeId}`);
  
  // 检查binId的完整性
  const expectedBinIds = new Set<number>();
  for (let i = minBin.binId; i <= maxBin.binId; i++) {
    expectedBinIds.add(i);
  }
  
  const actualBinIds = new Set(allBins.map(bin => bin.binId));
  
  // 找出缺失的binId
  const missingBinIds: number[] = [];
  for (const expectedId of expectedBinIds) {
    if (!actualBinIds.has(expectedId)) {
      missingBinIds.push(expectedId);
    }
  }
  
  console.log(`\nbinId范围: ${minBin.binId} 到 ${maxBin.binId}`);
  console.log(`期望的binId数量: ${expectedBinIds.size}`);
  console.log(`实际的binId数量: ${actualBinIds.size}`);
  
  let isComplete = false;
  let minToActiveComplete = false;
  
  if (missingBinIds.length === 0) {
    console.log('✅ 所有binId都存在，数据完整');
    isComplete = true;
    minToActiveComplete = true;
  } else {
    console.log(`❌ 缺失的binId数量: ${missingBinIds.length}`);
    console.log('缺失的binId:', missingBinIds.slice(0, 10).join(', ') + (missingBinIds.length > 10 ? '...' : ''));
    
    // 如果有缺失的binId，检查从最小binId到activeId之间的完整性
    console.log('\n--- 检查最小binId到activeId之间的完整性 ---');
    const minToActiveExpected = new Set<number>();
    for (let i = minBin.binId; i <= activeId; i++) {
      minToActiveExpected.add(i);
    }
    
    const minToActiveMissing: number[] = [];
    for (const expectedId of minToActiveExpected) {
      if (!actualBinIds.has(expectedId)) {
        minToActiveMissing.push(expectedId);
      }
    }
    
    console.log(`最小binId到activeId范围: ${minBin.binId} 到 ${activeId}`);
    console.log(`期望的binId数量: ${minToActiveExpected.size}`);
    const actualInRange = Array.from(actualBinIds).filter(id => id >= minBin.binId && id <= activeId);
    console.log(`实际的binId数量: ${actualInRange.length}`);
    
    if (minToActiveMissing.length === 0) {
      console.log('✅ 最小binId到activeId之间的所有binId都存在');
      minToActiveComplete = true;
    } else {
      console.log(`❌ 最小binId到activeId之间缺失的binId数量: ${minToActiveMissing.length}`);
      console.log('缺失的binId:', minToActiveMissing.slice(0, 10).join(', ') + (minToActiveMissing.length > 10 ? '...' : ''));
    }
  }
  
  console.log('=== 分析完成 ===\n');
  return {isComplete, minToActiveComplete};
}

// 处理单个pool的函数
async function processPool(connection: Connection, poolAddress: string) {
  const startTime = Date.now();
  console.log(`\n🚀 [${poolAddress}] 开始处理 - ${new Date().toISOString()}`);
  
  const poolPubkey = new PublicKey(poolAddress);
  
  try {
    // 创建DLMM实例
    const dlmmCreateStart = Date.now();
    const dlmmPool = await DLMM.create(connection, poolPubkey);
    const dlmmCreateTime = Date.now() - dlmmCreateStart;
    console.log(`⏱️  [${poolAddress}] DLMM实例创建耗时: ${dlmmCreateTime}ms`);
    
    // 获取所有bin arrays
    const getBinArraysStart = Date.now();
    const binArrays = await dlmmPool.getBinArrays();
    const getBinArraysTime = Date.now() - getBinArraysStart;
    console.log(`⏱️  [${poolAddress}] 获取binArrays耗时: ${getBinArraysTime}ms`);
    console.log(`📊 [${poolAddress}] 获取到 ${binArrays.length} 个bin arrays`);
      
      // 获取代币精度
      const tokenXDecimals = dlmmPool.tokenX.mint.decimals;
      const tokenYDecimals = dlmmPool.tokenY.mint.decimals;
      
      // 准备输出数据
      const dataProcessingStart = Date.now();
      const outputData = {
        poolAddress: poolAddress,
        tokenX: dlmmPool.tokenX.publicKey.toString(),
        tokenY: dlmmPool.tokenY.publicKey.toString(),
        tokenXDecimals: tokenXDecimals,
        tokenYDecimals: tokenYDecimals,
        binStep: dlmmPool.lbPair.binStep.toString(),
        activeId: dlmmPool.lbPair.activeId.toString(),
        timestamp: new Date().toISOString(),
        binArrays: binArrays.map(binArray => ({
          publicKey: binArray.publicKey.toString(),
          index: binArray.account.index.toString(),
          version: binArray.account.version.toString(),
          lbPair: binArray.account.lbPair.toString(),
          bins: binArray.account.bins.map((bin, binIndex) => {
            // 计算实际的bin ID
            const binArrayIndex = parseInt(binArray.account.index.toString());
            const binId = binArrayIndex * 70 + binIndex;
            
            // 使用SDK的getPriceOfBinByBinId获取pricePerLamport
            const binStep = Number(dlmmPool.lbPair.binStep.toString());
            const pricePerLamport = getPriceOfBinByBinId(binId, binStep);
            
            // 根据SDK源码计算实际价格: pricePerToken = pricePerLamport * 10^(baseTokenDecimal - quoteTokenDecimal)
            // 这里baseToken是tokenX，quoteToken是tokenY
            const actualPrice = new Decimal(pricePerLamport.toString())
              .mul(new Decimal(10).pow(tokenXDecimals - tokenYDecimals))
              .toString();
            
            return {
              binId: binId,
              liquiditySupply: bin.liquiditySupply.toString(),
              priceLamport: bin.price.toString(),
              pricePerLamport: pricePerLamport.toString(),
              actualPrice: actualPrice,
              amountX: bin.amountX.toString(),
              amountY: bin.amountY.toString()
            };
          })
        }))
      };
      const dataProcessingTime = Date.now() - dataProcessingStart;
      console.log(`⏱️  [${poolAddress}] 数据处理耗时: ${dataProcessingTime}ms`);
    
    // 分析bin数据
    const analysisStart = Date.now();
    const analysisResult = analyzeBinData(outputData);
    const analysisTime = Date.now() - analysisStart;
    console.log(`⏱️  [${poolAddress}] 数据分析耗时: ${analysisTime}ms`);
    
    // 输出到控制台（临时注释掉以避免输出过长）
    // console.log(JSON.stringify(outputData, null, 2));
    
    // 保存到JSON文件
    const fileSaveStart = Date.now();
    const dataDir = 'data/binArrays';
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const filename = `${dataDir}/binArrays_${poolAddress}.json`;
    fs.writeFileSync(filename, JSON.stringify(outputData, null, 2));
    const fileSaveTime = Date.now() - fileSaveStart;
    console.log(`⏱️  [${poolAddress}] 文件保存耗时: ${fileSaveTime}ms`);
    console.log(`\n[${poolAddress}] 数据已保存到文件: ${filename}`);
    
    // 如果数据完整，执行额外的保存操作
    let extraSaveTime = 0;
    if (analysisResult.isComplete || analysisResult.minToActiveComplete) {
      console.log(`\n[${poolAddress}] --- 执行额外保存操作 ---`);
      const extraSaveStart = Date.now();
      
      // 检查data/pool下是否存在对应的JSON文件
      const poolFilePath = `data/pool/${poolAddress}.json`;
      if (fs.existsSync(poolFilePath)) {
        try {
          // 读取pool文件内容
          const poolData = fs.readFileSync(poolFilePath, 'utf8');
          
          // 保存到data/目录
          const dataRootPath = `data/${poolAddress}.json`;
          fs.writeFileSync(dataRootPath, poolData);
          console.log(`✅ [${poolAddress}] 已保存到: ${dataRootPath}`);
          
          // 创建history目录
          const historyDir = 'data/history/pool';
          if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
          }
          
          // 移动到history目录
          const historyPath = `${historyDir}/${poolAddress}.json`;
          fs.renameSync(poolFilePath, historyPath);
          console.log(`✅ [${poolAddress}] 已移动到: ${historyPath}`);
          
        } catch (error) {
          console.error(`❌ [${poolAddress}] 额外保存操作失败:`, error);
        }
      } else {
        console.log(`⚠️  [${poolAddress}] 未找到文件: ${poolFilePath}`);
      }
      
      extraSaveTime = Date.now() - extraSaveStart;
      console.log(`⏱️  [${poolAddress}] 额外保存操作耗时: ${extraSaveTime}ms`);
    }
    
    // 计算总耗时
    const totalTime = Date.now() - startTime;
    console.log(`\n🎉 [${poolAddress}] 任务完成! 总耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
    console.log(`📊 [${poolAddress}] 性能统计:`);
    console.log(`   - DLMM实例创建: ${dlmmCreateTime}ms`);
    console.log(`   - 获取binArrays: ${getBinArraysTime}ms`);
    console.log(`   - 数据处理: ${dataProcessingTime}ms`);
    console.log(`   - 数据分析: ${analysisTime}ms`);
    console.log(`   - 文件保存: ${fileSaveTime}ms`);
    if (analysisResult.isComplete || analysisResult.minToActiveComplete) {
      console.log(`   - 额外保存操作: ${extraSaveTime}ms`);
    }
    console.log(`   - 总耗时: ${totalTime}ms\n`);
    
    return {
      poolAddress,
      binArrays,
      totalTime,
      dlmmCreateTime,
      getBinArraysTime,
      dataProcessingTime,
      analysisTime,
      fileSaveTime,
      extraSaveTime,
      analysisResult
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [${poolAddress}] 获取bin arrays时出错 (耗时: ${totalTime}ms):`, error);
    throw error;
  }
}

// 解析命令行参数
function parseCommandLineArgs(): string[] {
  const args = process.argv.slice(2);
  
  // 查找 -pool 参数
  const poolIndex = args.indexOf('-pool');
  
  if (poolIndex !== -1 && poolIndex + 1 < args.length) {
    // 获取 -pool 后面的参数
    const poolArg = args[poolIndex + 1];
    
    // 处理引号情况
    let poolAddresses: string[] = [];
    
    // 首先检查是否整个参数被引号包围
    if ((poolArg.startsWith('"') && poolArg.endsWith('"')) || 
        (poolArg.startsWith("'") && poolArg.endsWith("'"))) {
      // 整个参数被引号包围，可能是单个地址或逗号分隔的多个地址
      const unquotedArg = poolArg.slice(1, -1);
      if (unquotedArg.includes(',')) {
        // 逗号分隔的多个地址
        poolAddresses = unquotedArg.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0);
      } else {
        // 单个地址
        poolAddresses = [unquotedArg];
      }
    } else if (poolArg.includes(',')) {
      // 逗号分隔的多个地址，可能包含引号
      poolAddresses = poolArg.split(',').map(addr => {
        // 移除每个地址前后的引号和空格
        let cleanAddr = addr.trim();
        if ((cleanAddr.startsWith('"') && cleanAddr.endsWith('"')) || 
            (cleanAddr.startsWith("'") && cleanAddr.endsWith("'"))) {
          cleanAddr = cleanAddr.slice(1, -1).trim();
        }
        return cleanAddr;
      }).filter(addr => addr.length > 0);
    } else {
      // 单个地址（无引号）
      poolAddresses = [poolArg];
    }
    
    console.log(`📋 从命令行参数 -pool 获取到 ${poolAddresses.length} 个pool地址:`);
    poolAddresses.forEach((addr, index) => {
      console.log(`   ${index + 1}. ${addr}`);
    });
    return poolAddresses;
  }
  
  // 如果没有找到 -pool 参数，检查是否有其他参数（向后兼容）
  if (args.length > 0) {
    console.log(`📋 从命令行参数获取到 ${args.length} 个pool地址:`);
    args.forEach((addr, index) => {
      console.log(`   ${index + 1}. ${addr}`);
    });
    return args;
  }
  
  // 否则使用默认的pool地址列表
  const defaultPoolAddresses = [
    ''
  ];
  
  console.log(`📋 使用默认pool地址列表 (${defaultPoolAddresses.length} 个):`);
  defaultPoolAddresses.forEach((addr, index) => {
    console.log(`   ${index + 1}. ${addr}`);
  });
  
  return defaultPoolAddresses;
}

// 并行处理多个pool的主函数
async function getBinArrays() {
  const overallStartTime = Date.now();
  console.log(`\n🚀 开始并行处理多个pool - ${new Date().toISOString()}`);
  
  // 连接到Solana网络
  const connection = new Connection('https://api.mainnet-beta.solana.com');
  
  // 获取要处理的pool地址列表（命令行参数优先）
  const poolAddresses = parseCommandLineArgs();
  
  try {
    // 并行处理所有pool
    const results = await Promise.allSettled(
      poolAddresses.map(poolAddress => processPool(connection, poolAddress))
    );
    
    const overallTotalTime = Date.now() - overallStartTime;
    
    // 统计结果
    console.log(`\n🎯 所有任务完成! 总耗时: ${overallTotalTime}ms (${(overallTotalTime / 1000).toFixed(2)}s)`);
    console.log(`\n📊 处理结果统计:`);
    
    let successCount = 0;
    let failureCount = 0;
    let totalBinArrays = 0;
    
    results.forEach((result, index) => {
      const poolAddress = poolAddresses[index];
      if (result.status === 'fulfilled') {
        successCount++;
        totalBinArrays += result.value.binArrays.length;
        console.log(`✅ [${poolAddress}] 成功 - ${result.value.binArrays.length} 个bin arrays, 耗时: ${result.value.totalTime}ms`);
      } else {
        failureCount++;
        console.log(`❌ [${poolAddress}] 失败 - ${result.reason.message}`);
      }
    });
    
    console.log(`\n📈 总结:`);
    console.log(`   - 成功: ${successCount}/${poolAddresses.length}`);
    console.log(`   - 失败: ${failureCount}/${poolAddresses.length}`);
    console.log(`   - 总bin arrays: ${totalBinArrays}`);
    console.log(`   - 总耗时: ${overallTotalTime}ms (${(overallTotalTime / 1000).toFixed(2)}s)`);
    
    return results;
    
  } catch (error) {
    const overallTotalTime = Date.now() - overallStartTime;
    console.error(`❌ 并行处理失败 (耗时: ${overallTotalTime}ms):`, error);
    throw error;
  }
}

// 执行函数
getBinArrays()
  .catch(error => {
    console.error('执行失败:', error);
  });
