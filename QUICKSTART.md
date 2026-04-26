# 快速开始指南

## 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 http://localhost:5173/idempotency-kb/

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npm run preview` | 预览生产构建 |

## 部署到 GitHub Pages

推送代码到 main 分支即可自动部署：

```bash
git add .
git commit -m "update content"
git push origin main
```

GitHub Actions 会自动构建并部署网站。

访问: https://jarodchen.github.io/idempotency-kb/

## 自定义主题
