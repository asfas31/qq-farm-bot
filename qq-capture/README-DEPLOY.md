# qq-capture 部署说明

## Windows

解压 Windows 包后，将 `config.example.yaml` 复制为 `config.yaml`，按需填写 `public_host`，再执行：

```powershell
.\scripts\run-windows.ps1 -PublicHost 192.168.1.20
```

首次启动会在 `certs/` 生成 CA 证书。将该目录作为持久化数据保存，升级时不要覆盖。Windows 防火墙需允许 TCP `8080` 及 `5000-5099`；若修改 `proxy_base_port`，同步开放后续连续 100 个端口。

## Linux + systemd

将 Linux 包解压至 `/opt/qq-capture`，创建系统用户 `qqcapture`，并准备：

- `/etc/qq-capture/qq-capture.env`：从 `.env.example` 创建，设置 `PUBLIC_HOST`、`CERT_DIR=/var/lib/qq-capture/certs`。
- `/var/lib/qq-capture/certs`：由 `qqcapture` 用户拥有。

复制 `deploy/systemd/qq-capture.service` 到 `/etc/systemd/system/` 后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qq-capture
curl -fsS http://127.0.0.1:8080/api/health
```

## Docker Compose

在 Compose 目录创建真实 `config.yaml` 和 `.env`，再执行：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

`data/certs` 是证书持久化目录。默认 Compose 同时发布 `8080` 和 `5000-5099`；更改代理基础端口时，必须同步更新容器端口映射、宿主机防火墙与安全组。
