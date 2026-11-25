# Minecraft 服务端面板

自托管的 Minecraft Java 服务端管理面板。支持从 Linux 主机的现有目录添加实例、启停和重启、查看游戏输出、发送 Minecraft 命令，以及打开独立的 Linux 网页终端。

## 安装

需要 Linux、Node.js 20 或更新版本、npm、Python 3、tmux 和可用的 systemd 用户服务。按各实例的要求准备 Java。使用拥有整合包目录访问权限的普通用户安装和运行。

    bash install.sh

面板默认监听 127.0.0.1:51865。远程部署可以通过已有的安全转发访问。例如在客户端运行以下命令，再打开本机的 51865 端口。

    ssh -N -L 51865:127.0.0.1:51865 user@server

面板没有账号系统。能访问面板的人可以通过终端执行当前系统用户权限允许的操作。由部署者在代理、VPN 或转发层控制访问。反向代理需要保留访客 Host 头和支持 WebSocket 升级。使用自定义域名时，在 ~/.config/minecraft-panel/environment 中设置 MC_PANEL_ALLOWED_HOSTS 为逗号分隔的主机名。MC_PANEL_BIND 可设置监听地址，默认是 127.0.0.1。改变环境文件后重启面板服务。

    systemctl --user restart minecraft-panel
    journalctl --user -u minecraft-panel -f

如需开机启动并在退出 SSH 后继续运行，在系统允许时执行 loginctl enable-linger USER。面板使用独立的 tmux 服务进程运行游戏，重启面板时游戏可继续运行。实例活动期间浏览器可以安全断开连接。

## 导入与运行

1. 点击「添加实例」，填写 Linux 主机上的目录，或在网页里浏览选择。
2. 扫描目录并确认启动入口。常见入口包括原版和 Fabric 服务端 JAR、Forge 和 NeoForge 的 Linux 参数文件。重新命名的 JAR 可通过内部特征识别。若发现多个入口，手动选择要用的版本。
3. 核对 Java 可执行文件和可选的开服前脚本。前置脚本通过 Bash 从该实例目录执行。目录扫描只读取已有文件。保存实例后，点击「启动」。
4. 停止会发送 Minecraft 的 stop 命令并等待实例退出。选择实例可查看控制台。变更启动设置前先停服。

实例原地运行，继续使用原有世界和配置。面板只处理已经准备好的服务端目录。ZIP 上传排在后续阶段，自动下载整合包暂缓。启动时若缺少文件、Java 无法运行或端口占用，会显示对应错误。Minecraft EULA 由服务器管理员在实例目录确认。

端口可在网页「设置」里调整。若新端口已被占用，原端口继续工作。使用端口转发时，需要同步更新转发目标。

面板状态默认保存在 ~/.local/state/minecraft-panel/settings.json。开发运行时可以设置 MC_PANEL_STATE_DIR，隔离实例配置和 tmux 会话。

## 本地检查

    npm ci
    npm run check
    python3 -m unittest discover -s tests -v
    npm start
