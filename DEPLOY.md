# 部署指南

## GitHub Pages 自动部署

本项目已配置 GitHub Actions 自动部署到 GitHub Pages。

### 部署流程

1. **推送代码到 main 分支**
   ```bash
   git add .
   git commit -m "update content"
   git push origin main
   ```

2. **自动触发部署**
   - GitHub Actions 会自动构建 VitePress 站点
   - 只部署生成的静态文件（`docs/.vitepress/dist/`）
   - Markdown 源码不会暴露

3. **访问网站**
   - 部署完成后访问: https://jarodchen.github.io/idempotency-kb/
   - 通常需要 1-2 分钟生效

### 手动触发部署

如果需要手动触发部署：
1. 进入仓库的 Actions 页面
2. 选择 "Deploy to GitHub Pages" 工作流
3. 点击 "Run workflow"

### 配置 GitHub Pages

在 GitHub 仓库设置中：
1. 访问 Settings → Pages
2. Source 选择 "GitHub Actions"
3. 保存设置

### 注意事项

- ✅ Markdown 源文件保留在仓库中，但不会被部署到网站
- ✅ 只有构建后的 HTML/CSS/JS 会被发布
- ✅ 每次推送到 main 分支都会自动重新部署
- ✅ 支持自定义域名配置

### 本地测试

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

## 本地部署

### 构建生产版本

```bash
npm run build
```

生成的静态文件位于 `docs/.vitepress/dist/` 目录。

### 使用 Nginx 部署

``nginx
server {
    listen 80;
    server_name your-domain.com;
    
    root /path/to/Idempotency-kb-vitepress/docs/.vitepress/dist;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 使用 Docker 部署

创建 `Dockerfile`:

```dockerfile
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/docs/.vitepress/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

构建并运行：

```bash
docker build -t idempotency-kb .
docker run -p 80:80 idempotency-kb
```

## 自定义域名

在 `docs/.vitepress/dist/` 目录下创建 `CNAME` 文件：

```
your-domain.com
```

或者在 GitHub Pages 设置中添加自定义域名。

## 环境变量

如果需要配置环境变量，在项目根目录创建 `.env` 文件：

```env
VITE_BASE_URL=/Idempotency-kb/
```

## 故障排查

### 构建失败

```bash
# 清除缓存
rm -rf node_modules
rm -rf docs/.vitepress/cache

# 重新安装
npm install

# 重新构建
npm run build
```

### 404 错误

确保 `docs/.vitepress/config.ts` 中的 `base` 配置正确：

```typescript
export default defineConfig({
  base: '/Idempotency-kb/', // 与仓库名称一致
})
```

### GitHub Actions 失败

1. 检查 Node.js 版本（需要 18+）
2. 查看 Actions 日志了解详细错误
3. 确保所有依赖都已正确安装
