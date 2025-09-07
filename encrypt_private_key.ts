import * as dotenv from 'dotenv';
import CryptoJS from 'crypto-js';
import * as readline from 'readline';

// 加载环境变量
dotenv.config();

/**
 * 加密私钥
 * @param privateKey 原始私钥
 * @param password 加密密码
 * @returns 加密后的私钥字符串
 */
function encryptPrivateKey(privateKey: string, password: string): string {
  return CryptoJS.AES.encrypt(privateKey, password).toString();
}

/**
 * 创建交互式输入接口
 */
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * 安全输入密码（隐藏输入）
 */
function secureInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createReadlineInterface();
    
    // 隐藏输入
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    let input = '';
    
    process.stdin.on('data', (key: Buffer) => {
      const keyStr = key.toString();
      if (keyStr === '\r' || keyStr === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
        console.log(); // 换行
        resolve(input);
      } else if (keyStr === '\u0003') { // Ctrl+C
        process.exit();
      } else if (keyStr === '\u007f') { // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += keyStr;
        process.stdout.write('*');
      }
    });
  });
}

/**
 * 主函数
 */
async function main() {
  console.log('🔐 私钥加密工具');
  console.log('================');
  
  try {
    // 获取原始私钥
    const rl = createReadlineInterface();
    const privateKey = await new Promise<string>((resolve) => {
      rl.question('请输入原始私钥 (Base58格式): ', resolve);
    });
    rl.close();
    
    if (!privateKey || privateKey.trim() === '') {
      throw new Error('私钥不能为空');
    }
    
    // 获取加密密码
    const password = await secureInput('请输入加密密码: ');
    
    if (!password || password.trim() === '') {
      throw new Error('密码不能为空');
    }
    
    // 确认密码
    const confirmPassword = await secureInput('请再次输入密码确认: ');
    
    if (password !== confirmPassword) {
      throw new Error('两次输入的密码不一致');
    }
    
    // 加密私钥
    const encryptedPrivateKey = encryptPrivateKey(privateKey, password);
    
    console.log('\n✅ 私钥加密成功！');
    console.log('================');
    console.log('加密后的私钥:');
    console.log(encryptedPrivateKey);
    console.log('\n📝 请将以下内容添加到 .env 文件中:');
    console.log('================');
    console.log(`PRIVATE_KEY=${encryptedPrivateKey}`);
    console.log('PRIVATE_KEY_ENCRYPTED=true');
    console.log(`PRIVATE_KEY_PASSWORD=${password}`);
    console.log('\n⚠️  安全提示:');
    console.log('- 请妥善保管加密密码');
    console.log('- 建议将 .env 文件添加到 .gitignore');
    console.log('- 不要将加密私钥和密码提交到版本控制系统');
    
  } catch (error) {
    console.error('❌ 错误:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// 如果直接运行此文件，则执行main函数
if (require.main === module) {
  main();
}

export { encryptPrivateKey };
