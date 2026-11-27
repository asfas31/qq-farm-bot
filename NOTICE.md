# 仓库用途声明

本仓库（`https://github.com/asfas31/qq-farm-bot`）是**个人自用更新仓库**。

## 用途

- 存放仓库所有者本人部署实例（`/opt/qq-farm-bot`）的源码
- 作为面板「版本更新」功能的更新源：`origin/main` 分支的最新提交即本人实例要部署的版本
- 保存部署过程中的备份、回滚点与配置说明

## 边界

- 不是官方发布渠道，不代表任何上游项目的官方版本
- 不对外提供下载、安装、更新、部署或技术支持
- 分支与提交按本人实例的需要推进，可能包含仅适用于本人环境的定制，不保证在其他环境可用
- 仓库内不存放运行期数据与密钥：`.env`、`core/data/`、`node_modules/`、`dist/`、`runtime/`、日志与备份文件均已排除

## 更新方式

面板「设置 → 版本更新」检查与拉取的对象是本仓库 `main` 分支。拉取后按部署方式重建：

```bash
cd /opt/qq-farm-bot
git log --oneline -1
NODE_OPTIONS=--max-old-space-size=1536 pnpm build
sudo systemctl restart qq-farm-bot
```
