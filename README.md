## Meteora DLMM 自动化策略与运维工具

本项目聚焦于在 Solana 上基于 Meteora DLMM 的自动化流动性管理与运维编排，包含：
- 使用 `@meteora-ag/dlmm` 进行创建扩展仓位、按策略添加/移除流动性
- 基于 OKX Web3 DEX 接口拉取价格/K线，辅助 Bin 范围计算与风控
- 领取仓位产生的手续费与奖励，并在到账后自动通过本地 `jupSwap` 可执行文件做兑换
- 使用 Go 程序进行文件监听、定时任务（价格抓取、全局领取、定时 swap）与日志落盘

### 目录结构

```
/Users/yqw/meteora_dlmm
├── addLiquidity.ts            # 添加流动性（创建扩展仓位、大范围 bins、策略添加）
├── removeLiquidity.ts         # 移除流动性（默认全移+可选 jupSwap）
├── claimAllRewards.ts         # 按仓位领取手续费/奖励并智能等待后执行 jupSwap
├── fetchPrice.ts              # 价格工具（被 Go 调用；含 OKX DEX 实时价格）
├── main.go                    # Go 调度程序：文件监听、定时任务、日志
├── jupSwap                    # 本地可执行文件：做兑换（被 TS/Go 调用）
├── data/
│   ├── ban/ban.csv            # 代币黑名单（以逗号分隔，支持中英文逗号）
│   ├── history/               # 历史归档的池 JSON（移除+swap 成功后迁移）
│   ├── log/                   # 运行日志，按时间戳命名
│   └── prices/                # 本地价格缓存（fetchPrice.ts 写入）
├── package.json               # Node 依赖（仅列出依赖，脚本自行按命令执行）
├── go.mod / go.sum            # Go 依赖
├── tsconfig.json              # TypeScript 配置
├── swap.env / test.env        # 示例环境变量（勿在 README 步骤里修改 .env）
└── node_modules/              # 依赖目录
```

### 运行环境

- Node.js 18+（推荐 20+）
- pnpm/npm 任一（示例使用 npx）
- Go 1.21+
- Solana 主网（`clusterApiUrl('mainnet-beta')`）

### 安装依赖

```bash
cd /Users/yqw/meteora_dlmm
npm install
go mod download
```

### 必要的环境变量

项目通过 `dotenv` 读取环境变量（不要提交真实密钥；勿修改项目内的 `.env` 文件，请在个人环境中设置）：

- 私钥与钱包
  - `PRIVATE_KEY_ENCRYPTED=true`            # 仅支持加密私钥
  - `PRIVATE_KEY`                           # 使用 AES 加密后的私钥（Base58 secret key 加密产物）
  - `PRIVATE_KEY_PASSWORD`                  # 解密密码
  - `USER_WALLET_ADDRESS`                   # 用户钱包地址（Base58）

- 池与仓位
  - `POOL_ADDRESS`                          # DLMM 池地址（Base58）
  - `POSITION_ADDRESS`                      # 仓位地址（可由脚本写入 data/<pool>.json 后复用）

- 交易/策略参数
  - `SOL_AMOUNT`                            # 添加流动性时的 SOL 数量（小数）
  - `BIN_RANGE_MODE`                        # `last_updated_first` 或自动模式（默认 `last_updated_first`）

- OKX Web3 DEX（可选，启用后需全部提供）
  - `OKX_API_KEY`
  - `OKX_SECRET_KEY`
  - `OKX_PASSPHRASE`
  - `ENABLE_OKX`                            # `true`/`1` 开启；否则默认关闭

说明：
- 部分脚本支持命令行参数覆盖环境变量（优先级：命令行 > JSON 文件（部分）> 环境变量）。
- `.env` 文件严禁在此项目中修改或提交；请在本机以安全方式注入变量。

### 数据与日志

- `data/<pool>.json`：池相关的运行数据，脚本会写入/读取：
  - `positionAddress`：仓位地址（顶层与 `data.positionAddress` 同步）
  - `ca`：X 代币合约地址（顶层与 `data.ca` 同步）
  - `poolName`：池名（顶层与 `data.poolName` 同步）
  - `c`：K 线收盘价（由 `addLiquidity.ts` 在 OKX 命中后写入）
  - `last_updated_first`：外部 CSV 传入的时间串（供策略使用）
- `data/history/*.json`：完成移除+兑换后，源 JSON 会迁档至此
- `data/log/app_*.log`：Go 程序运行日志（包含子进程输出）
- `data/ban/ban.csv`：黑名单 ca，逗号分隔；会在 `main.go` 的 jupSwap 流程中过滤
- `data/prices/<mint-or-ca>.json`：价格缓存

### 核心流程概览

1) Go 调度（`main.go`）
- 监听外部 CSV（`/Users/yqw/dlmm_8_27/data/auto_profit.csv`）与 `data/` 目录：
  - 新增 CSV 行会被解析并写入 `data/<pool>.json`
  - 发现新 `*.json` 文件，调用 Node：
    ```bash
    npx ts-node addLiquidity.ts --pool=<poolAddress> [--token=<ca>] [--last_updated_first="YYYY-MM-DD HH:mm:ss"]
    ```
- 定时任务：
  - 价格抓取：每分钟第 01 秒，遍历 `data/*.json` 的 ca 获取价格，依据 5 小时阈值尝试移除
  - 全局领取：每分钟的 10s 与 40s，遍历池按 JSON 中的 `positionAddress` 领取
  - jupSwap：每分钟第 06 秒，先读取持仓代币列表，再逐个执行 `./jupSwap`

2) 添加流动性（`addLiquidity.ts`）
- 读取 `POOL_ADDRESS` 与 `SOL_AMOUNT`，支持 `--pool=...` 覆盖
- 支持“扩展空仓位 + BidAsk 策略”添加，突破 70 bins 限制
- Bin 范围计算：
  - `BIN_RANGE_MODE=last_updated_first`（默认）：可结合 `--last_updated_first` 与 OKX 最新价/收盘价对比决定范围
  - 自动模式：按 `activeId` 与 `binStep` 动态向左扩展（约 40% 跌幅对应 bins）
- 如果池 JSON 中不存在 `positionAddress`，会创建并持久化（带文件锁避免并发）

3) 领取奖励（`claimAllRewards.ts`）
- 优先级：`--position` > `data/<pool>.json` > `POSITION_ADDRESS`
- 先用 Meteora API 查询“累计已领取 USD”并读取本地价格，若累计 + 持仓 + 未领取 ≥ 1.05 SOL(USD)，触发移除逻辑
- 否则走 `dlmmPool.claimAllRewardsByPosition`，成功后智能等待代币到账并执行 `./jupSwap`

4) 移除流动性（`removeLiquidity.ts`）
- 默认全范围、全额移除，并在成功后（可选跳过）尝试执行 `jupSwap`
- 成功 swap 后自动将 `data/<pool>.json` 迁移到 `data/history/`

### 常用命令示例

添加流动性（可结合 OKX 与 last_updated_first）
```bash
cd /Users/yqw/meteora_dlmm
npx ts-node addLiquidity.ts \
  --pool=<POOL_ADDRESS> \
  --token=<X_TOKEN_CA> \
  --last_updated_first="2025-09-11 05:02:00" \
  --enable-okx
```

领取奖励（优先从 JSON 读取仓位地址）
```bash
npx ts-node claimAllRewards.ts --pool=<POOL_ADDRESS>
```

移除流动性（并在成功后自动 jupSwap，支持关闭）
```bash
npx ts-node removeLiquidity.ts --pool=<POOL_ADDRESS> --position=<POSITION_ADDRESS>
# 或仅指定 --pool，让脚本从 data/<pool>.json 读取
```

运行 Go 调度（监听 + 定时）
```bash
go run main.go
```

价格工具（被 Go 调用；如需手动）
```bash
npx ts-node fetchPrice.ts --pool=<POOL_ADDRESS> --token=<MINT_OR_CA>
```

说明：
- `./jupSwap` 为本地可执行文件；TS 与 Go 都会调用它，需确保可执行权限：
  ```bash
  chmod +x ./jupSwap
  ```

### 黑名单与风控

- 在 `data/ban/ban.csv` 写入需要排除的 ca，逗号分隔（支持中文逗号），Go 程序会在解析持仓列表时过滤。
- Go 侧默认对 OKX、jupSwap 等调用设置了超时与串行节流，避免被平台限流或本机过载。
- 5 小时存在期：在价格抓取任务中会检查 `last_updated_first` 推断的存在时长，超过 5 小时会自动执行移除尝试。

### 安全注意事项

- 私钥仅支持加密形式；解密通过 `PRIVATE_KEY_PASSWORD` 在本地内存完成。
- 严禁将 `.env` 或任何密钥文件提交到版本库；请使用系统环境变量或安全的密钥管理方案。
- 运行前务必确认 `USER_WALLET_ADDRESS` 与解密后的私钥对应的钱包一致，脚本会输出校验提示。

### 故障排查

- 查看最新日志：`data/log/app_YYYY-MM-DD_HH-MM-SS.log`
- 常见报错：
  - 缺少环境变量：按上文“必要的环境变量”补齐
  - OKX 价格为空：未开启或凭证不完整；或 token 参数未提供
  - 余额不足：需 ≥ 0.06 SOL 以覆盖租金与手续费
  - `positionAddress` 缺失：先 `addLiquidity.ts` 创建或在 JSON 中补充

### 免责声明

本项目用于策略自动化与基础设施演示，不构成任何投资建议。链上操作存在风险，务必在充分理解后再投入真实资金，并自担责任。


