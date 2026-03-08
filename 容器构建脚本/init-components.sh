#!/bin/bash

# 安装必要软件
apt install -y curl nano jq bc tar xz-utils git

# 获取 7z 下载链接
latest_release_7z=$(curl -s https://api.github.com/repos/ip7z/7zip/releases/latest)
latest_7z_x64_url=$(echo "$latest_release_7z" | jq -r '.assets[] | select(.name | test("linux-x64.tar.xz")) | .browser_download_url')
latest_7z_arm64_url=$(echo "$latest_release_7z" | jq -r '.assets[] | select(.name | test("linux-arm64.tar.xz")) | .browser_download_url')

# 获取 biliup 下载链接
latest_release_biliup=$(curl -s https://api.github.com/repos/biliup/biliup/releases/latest)
latest_biliup_x64_url=$(echo "$latest_release_biliup" | jq -r '.assets[] | select(.name | test("x86_64-linux.tar.xz")) | .browser_download_url')
latest_biliup_arm64_url=$(echo "$latest_release_biliup" | jq -r '.assets[] | select(.name | test("aarch64-linux.tar.xz")) | .browser_download_url')

# 获取服务器架构
arch=$(uname -m)
if [[ $arch == *"x86_64"* ]]; then
    wget -O /root/tmp/7zz.tar.xz "$latest_7z_x64_url"
    wget -O /root/tmp/biliup.tar.xz "$latest_biliup_x64_url"
    wget -O /root/tmp/BililiveRecorder-CLI.zip https://github.com/BililiveRecorder/BililiveRecorder/releases/latest/download/BililiveRecorder-CLI-linux-x64.zip
    wget -O /root/tmp/DanmakuFactory https://raw.githubusercontent.com/xct258/khx-live/main/DanmakuFactory/DanmakuFactory-amd64
elif [[ $arch == *"aarch64"* ]]; then
    wget -O /root/tmp/7zz.tar.xz "$latest_7z_arm64_url"
    wget -O /root/tmp/biliup.tar.xz "$latest_biliup_arm64_url"
    wget -O /root/tmp/BililiveRecorder-CLI.zip https://github.com/BililiveRecorder/BililiveRecorder/releases/latest/download/BililiveRecorder-CLI-linux-arm64.zip
    wget -O /root/tmp/DanmakuFactory https://raw.githubusercontent.com/xct258/khx-live/main/DanmakuFactory/DanmakuFactory-arm64
fi

# 安装解压工具
apt install -y tar xz-utils
# 安装7zz
tar -xf /root/tmp/7zz.tar.xz -C /root/tmp
tar -xf /root/tmp/biliup.tar.xz -C /root/tmp
chmod +x /root/tmp/7zz
mv /root/tmp/7zz /bin/7zz

# 安装该镜像所需要的软件
apt install -y \
    ffmpeg \
    pciutils \
    fontconfig \
    procps \
    rclone \
    python3 \
    python3-pip

pip install \
    numpy \
    matplotlib \
    scipy \
    fastapi \
    uvicorn[standard] \
    jinja2 \
    pydantic \
    python-multipart \
    --break-system-packages

# 安装intel核显驱动
apt update
apt install -y gpg wget
wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg
echo "deb [arch=amd64,i386 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu jammy client" | tee /etc/apt/sources.list.d/intel-gpu-jammy.list
apt update
apt install -y intel-media-va-driver-non-free libmfx1 libmfxgen1 libvpl2 va-driver-all vainfo

# 安装该镜像所需要的字体
# 创建字体目录
mkdir -p /root/.fonts/
# 下载 Segoe Emoji 字体
wget -O "/root/.fonts/seguiemj.ttf" https://raw.githubusercontent.com/xct258/khx-live/refs/heads/main/字体/seguiemj.ttf
# 下载 微软雅黑 字体
wget -O "/root/.fonts/微软雅黑.ttf" https://raw.githubusercontent.com/xct258/khx-live/refs/heads/main/字体/微软雅黑.ttf
# 更新字体缓存
fc-cache -f -v

# 安装biliup
biliup_file=$(find /root/tmp -type f -name "biliup")
mkdir -p /root/biliup
mv "$biliup_file" /root/biliup/biliup
chmod +x /root/biliup/biliup

# 安装DanmakuFactory
mkdir -p /opt/bililive/apps
chmod +x /root/tmp/DanmakuFactory 
mv /root/tmp/DanmakuFactory /opt/bililive/apps/DanmakuFactory

# 安装BililiveRecorder
mkdir -p /root/BililiveRecorder
7zz x /root/tmp/BililiveRecorder-CLI.zip -o/root/BililiveRecorder
chmod +x /root/BililiveRecorder/BililiveRecorder.Cli

# 下载容器所需脚本
# 创建相关目录
mkdir -p /opt/bililive/config /opt/bililive/scripts /opt/bililive/biliup /opt/webclip /opt/webclip/static /opt/webclip/templates
# 下载视频处理相关脚本
wget -O /opt/bililive/config/config.conf https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/config.conf
wget -O /opt/bililive/scripts/录播上传备份脚本.sh https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/录播上传备份脚本.sh
wget -O /opt/bililive/scripts/压制视频.py https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/压制视频.py
wget -O /opt/bililive/scripts/封面获取.py https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/封面获取.py
wget -O /opt/bililive/scripts/ffmpeg视频处理.sh https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/ffmpeg视频处理.sh
wget -O /opt/bililive/biliup/biliup后处理.sh https://raw.githubusercontent.com/xct258/khx-live/main/biliup/biliup后处理.sh
wget -O /opt/bililive/scripts/log.sh https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/log.sh
wget -O /opt/bililive/scripts/自动选择onedrive网盘.sh https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/自动选择onedrive网盘.sh
wget -O /opt/bililive/scripts/弹幕偏移脚本.sh https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/弹幕偏移脚本.sh
wget -O /opt/bililive/scripts/xml转ass.sh https://raw.githubusercontent.com/xct258/khx-live/main/视频处理脚本/xml转ass.sh
wget -O /opt/webclip/app.py https://raw.githubusercontent.com/xct258/khx-live/main/在线切片/app.py
wget -O /opt/webclip/static/favicon.ico https://raw.githubusercontent.com/xct258/khx-live/main/在线切片/static/favicon.ico
wget -O /opt/webclip/static/script.js https://raw.githubusercontent.com/xct258/khx-live/main/在线切片/static/script.js
wget -O /opt/webclip/static/style.css https://raw.githubusercontent.com/xct258/khx-live/main/在线切片/static/style.css
wget -O /opt/webclip/templates/index.html https://raw.githubusercontent.com/xct258/khx-live/main/在线切片/templates/index.html
chmod +x /opt/bililive/scripts/*.sh
chmod +x /opt/bililive/biliup/*.sh
