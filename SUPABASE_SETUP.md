# Supabase 云端素材库配置

## 1. 创建数据表

在 Supabase 项目后台打开：

1. 左侧点击 `SQL Editor`
2. 点击 `New query`
3. 打开本项目的 `supabase-schema.sql`
4. 复制全部 SQL，粘贴到 Supabase SQL Editor
5. 点击 `Run`

运行成功后，会创建：

- `materials`：素材库，保存待改写/已改写文章
- `generations`：生成记录，保存标题、正文、卡片 JSON、Markdown

## 2. 配置后端密钥

后端从 `.env` 读取：

```env
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY=你的 Secret key
```

`SUPABASE_SERVICE_ROLE_KEY` 只能放后端，不能写进前端页面。

## 3. 验证连接

启动服务：

```powershell
node server.js
```

打开：

```text
http://localhost:5177/api/cloud/status
```

如果返回：

```json
{"configured":true,"ok":true}
```

说明云端素材库已接通。

## 4. 当前数据逻辑

- 页面加载时优先读取 Supabase 云端素材库。
- 第一次接通云端后，会把本地 `skills/文章抓取筛选/output` 的素材补充导入云端。
- 后续云端状态不会被本地旧文件覆盖。
- 关键词抓取写入云端 `materials`。
- 生成卡片后，素材状态会更新为 `rewritten`，刷新后仍在“已改写”。
