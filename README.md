# linglongxuan 配送点餐系统

手机点餐、商家核款、备餐进度、固定楼宇配送、私有图片和 Excel 导出。独立 Cloudflare Workers + D1 + R2 实现，无需 ChatGPT 账号或个人电脑持续开机。

这是脱敏的可运行源码快照。真实收款账号、二维码、管理员密码、客户数据、付款截图及平台凭据均不包含。菜单参考用户提供的餐厅资料；仓库默认收款信息只是演示，请勿向示例账号付款。

## 本机运行

需要 Node.js 22+（已在 Node 24 验证）。

```powershell
npm ci
npm run build
npm run validate
npm test
npm run seed:demo
npm run dev
```

打开 http://127.0.0.1:8790/ ，商家入口 /admin。首次启动随机生成本机管理员密码，写在被 Git 忽略的 .local/admin-login.txt；示例顾客的随机密码在 .local/example-logins.txt。不要把这些文件上传到仓库。

示例数据在 examples/orders.json。seed:demo 仅操作本机 Miniflare 数据库，拒绝参数和已有账号/订单的数据库，避免覆盖资料。停止预览后执行；不会向云端导入。也可跳过它，从空库注册和下单。

## 保留的功能

- 23 款餐品、绿豆汤 1/3/5、炒粉干五种规格；服务端计价。
- 纽约日期每日更新、午晚餐、每日批次覆盖、ASAP、8 个楼宇配送点、临时菜单。
- 顾客页显示首批至末批的预计发车范围；隐藏固定截止时间文案。后台截止设置及服务端校验保留。
- 手机号/密码登录，微信号必填；按账号隔离草稿、订单、凭证、简要历史。
- 确认订单 → 保存草稿 → 上传凭证 → 正式提交。上传失败或切换付款渠道不丢订单。
- 人工核款、独立付款与履约状态、备餐数量与完成确认、发车/送达纠错、送达照片。
- 前台轮询刷新、可配置新单提示、闲置退出、账号资料、再点一单返回可编辑餐袋。
- 已完成且款项已解决的订单删除图片；满七天先备份、人工确认清理完整订单，保留简要历史。
- 注册限频、基础挑战、邀请码/关注册/封禁；可配置真实 Turnstile 密钥。
- 图片由手机压缩，服务器做 JPEG 结构校验和元数据剥离；鉴权后读取私有 R2。

## 部署到自己的 Cloudflare

1. 登录自己的 Cloudflare 账号，保持 Workers Free。R2 必须激活，有免费额度但超额计费。
2. 运行 npx wrangler login、npx wrangler d1 create linglongxuan、npx wrangler r2 bucket create linglongxuan-private。
3. 复制 wrangler.example.json 为 wrangler.local.json，填写真实 database_id。此文件被 Git 忽略。
4. 运行 npx wrangler d1 migrations apply linglongxuan --remote --config wrangler.local.json。
5. 设置 ADMIN_PASSWORD_HASH 为 PBKDF2-SHA256 格式，示例格式是 pbkdf2$100000$随机盐十六进制$摘要十六进制。worker/core.js 导出 passwordHash 可生成；不能使用示例/测试密码。
6. 使用 npx wrangler secret put ADMIN_PASSWORD_HASH --config wrangler.local.json 安全输入哈希，再 npm run build 和 npx wrangler deploy --config wrangler.local.json。
7. 在商家后台配置真实收款信息并核对菜单。测试账号隔离、上传、核款、备餐、配送与导出后再接真实订单。

免费 Workers 有每请求 CPU 和每日请求上限。10 万请求不等于 10 万订单；未给出生产最大日单量承诺。照片清理和上传限频不是账单硬上限。微信内置浏览器和手机通知仍需真机验收。

新旧部署使用各自独立数据库，不自动同步账号或订单。完整迁移必须另做数据库与私有图片导出导入，不要把示例数据当成生产备份。
