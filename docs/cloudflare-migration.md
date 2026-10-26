# 独立 Cloudflare 部署

完整步骤见仓库 README 的“部署到自己的 Cloudflare”。本仓库不包含原平台身份、真实订单、原始付款信息或任何部署密钥。

先 `npm run build`。也可运行 `node scripts/prepare-cloudflare.mjs` 生成 `outputs/cloudflare-migration`，其中包含独立 Worker、数据库迁移、配置模板及 SHA-256 清单。提供真实 D1 UUID 作为参数时会生成对应配置。该脚本只生成本地文件，不创建账号资源、不启动收费服务。

首次部署为空数据库，管理员必须单独设置 `ADMIN_PASSWORD_HASH`。演示数据导入脚本仅支持本机，不应用于云端。新旧部署不会自动同步账号和订单，不能把开通新网址当成已经迁完生产数据。

Workers Free、D1 Free 和 R2 免费额度分别计数。R2 开通需要付款资料及按量订阅，免费额度不是账单封顶。完成订单后的照片清理仍通过业务操作触发；需检查清理失败待办。

顾客端不显示固定截止时间，后台截止控制和按日设置保留。手机微信浏览器、通知权限、每日批次、上传与免费 CPU 上限均需要上线实测。

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
