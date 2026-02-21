
# khx-live

`khx-live` 是括弧笑的直播录制、备份与管理容器化解决方案。它封装在一个 Debian 基础镜像内，整合了 **录播姬、biliup、DanmakuFactory** 等工具，并可选附带一个在线切片的 Web 应用，从而提供从直播获取到视频处理的全栈支持。

> 注意：本项目主要用于个人/小规模自动化需求，依赖 B 站及相关工具的接口，使用时请遵守平台规则，全部代码由AI生成。

---

## 核心功能

1. **录播姬自动录制**  
   容器启动后会运行 `BililiveRecorder.Cli` 并绑定 `2356` 端口，通过 HTTP Basic 登录控制录制任务。录制文件存放在宿主机挂载的 `/rec/录播姬`。

2. **biliup 上传与后处理**  
   镜像内包含最新的 `biliup` 二进制，可在宿主 `/rec/biliup` 下运行，如需使用容器内脚本，可通过 `/opt/bililive/biliup` 中的助手程序。

3. **视频处理脚本集合**  
   `/opt/bililive/scripts` 下存放了一套 FFmpeg 自动处理、封面获取、日志记录等实用 shell/python 脚本，镜像初始化时会同步到 `/rec/脚本`，方便用户自定义任务（例如上传/压制等）。

4. **在线切片 Web 服务（可选）**  
   简易的 FastAPI 应用，可在浏览器中预览 `/rec/录播姬` 下的视频并进行时间段裁剪。服务代码部署在 `/opt/webclip`，启动时由 `ENABLE_WEBCLIP` 环境变量控制。

5. **字体与工具支持**  
   自动下载 Segoe Emoji、微软雅黑等字体以保证弹幕与字幕渲染，内置 7zz 解压、rclone、DanmakuFactory 等小工具。

6. **私有配置下载**  
   若提供 `XCT258_GITHUB_TOKEN`，启动脚本会从私有仓库拉取 rclone 配置、bilibili cookies 等敏感文件。无 token 时完全跳过。

---

## 容器数据布局（`/rec`）

| 子目录            | 含义                                   |
|-------------------|----------------------------------------|
| `/rec/录播姬`      | BililiveRecorder 录制的视频            |
| `/rec/biliup`      | biliup 程序及相关脚本                  |
| `/rec/脚本`        | 视频处理脚本集合                        |
| `/rec/apps`        | 额外可执行的二进制（如 DanmakuFactory）  |
| `/rec/在线切片`    | 在线切片应用部署文件                    |
| `/rec/cookies`     | b站 cookies（通过私有下载）             |
| `/root/.config`    | rclone 等全局配置                      |

宿主机只需挂载一个目录到 `/rec`，容器内的数据即可持久化。

---

## 快速开始
1. **运行容器**
   ```sh
   docker run -d \
       --name khx-live \
       --net=host \
       -e XCT258_GITHUB_TOKEN="<your token>" \
       -e Bililive_USER="xct258" \
       -e Bililive_PASS="<password>" \
       -e ENABLE_WEBCLIP=true \
       -e WEBCLIP_PORT=8186 \
       -p 8186:8186 \
       -v /path/to/data:/rec \
       xct258/khx-live
   ```
   > 也可使用 `docker-compose up -d` 启动。

2. **访问服务**
   - 录播姬界面：`http://<host>:2356`  
   - 在线切片：`http://<host>:8186`（若启用）
   - biliup REST API 等由 container 内部调用。

3. **停止/重启**
   ```sh
   docker stop khx-live && docker start khx-live
   ```

---

## 环境变量详解

| 变量名                   | 描述                                           | 默认值      | 示例             |
|--------------------------|------------------------------------------------|-------------|------------------|
| `XCT258_GITHUB_TOKEN`    | GitHub 私有仓库访问令牌，用于下载敏感配置文件   | 空          | `abc123...`      |
| `Bililive_USER`          | 录播姬 HTTP Basic 用户名                        | `xct258`    | `myuser`         |
| `Bililive_PASS`          | 录播姬 HTTP Basic 密码                          | 随机生成    | `S7f9kLm0`       |
| `ENABLE_WEBCLIP`         | 是否启用在线切片 Web 应用                      | `false`     | `true`/`false`   |
| `WEBCLIP_PORT`           | 在线切片监听端口                                | `8186`      | `8080`           |
| `BILILIVE_ARGS`          | 额外传递给 `BililiveRecorder.Cli` 的命令行参数  | 空          | `--bind http://*:1234` |

---

## 构建与发布流程

GitHub Actions 工作流配置在 `.github/workflows/docker-image.yml`：

1. 每月 1 日通过 cron 自动触发构建。
2. 可通过“Workflow dispatch”手动触发。  
3. 构建时支持 `linux/amd64` 与 `linux/arm64` 多平台。  
4. 镜像推送目标为 Docker Hub 仓库 `xct258/khx-live`。

需要更新镜像标签或 CI 参数请编辑该文件。

---

## 常见问题与排查

1. **录播姬无法启动**：检查容器日志 `docker logs khx-live` 是否有权限或缺少 `BililiveRecorder.Cli`。
2. **视频文件未出现在 `/rec`**：确认宿主路径正确挂载，并且容器具有写权限。
3. **在线切片访问失败**：确认 `ENABLE_WEBCLIP` 已设为 `true`，端口映射正确，并且 `/rec/在线切片/app.py` 存在。
4. **私有配置下载失败**：检查 `XCT258_GITHUB_TOKEN` 是否有效，容器网络是否可访问 GitHub。

---

## 参与开发

欢迎你在 `xct258/khx-live` 仓库提交 PR：

- 增加新脚本或功能；
- 修复 bug；
- 改进文档。

本项目采用开放协作方式，具体许可证与贡献指南参考仓库根目录。

---