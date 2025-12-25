<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# 供应链智能看板（Vite + Node API）

这个项目把 **飞书 Base（多维表格）** + **Gemini** 的调用统一放到后端 `/api` 中转：

- ✅ 解决浏览器 CORS
- ✅ 不在前端暴露 **飞书 APP_SECRET / Token**、**Gemini API Key**

## 本地运行

**Prerequisites:** Node.js 18+

1) 安装依赖

`npm install`

2) 配置环境变量

复制一份 `.env.example` → `.env`，然后填写：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BASE_ID`
- `GEMINI_API_KEY`

3) 启动（前端 + 后端）

`npm run dev`

前端：http://localhost:3000
后端：http://localhost:8787

## 生产部署

1) `npm run build`
2) `npm run start`

> 生产环境同样通过 `.env` 或平台环境变量注入密钥。
